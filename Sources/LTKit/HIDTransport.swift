import Foundation
import IOKit
import IOKit.hid

public enum TransportError: Error, CustomStringConvertible {
    case noDevice
    case exclusiveAccess
    case openFailed(IOReturn)
    case writeFailed(IOReturn)
    case notOpen

    public var description: String {
        switch self {
        case .noDevice:
            return "No Mustang LT amp found on USB."
        case .exclusiveAccess:
            return "The amp is in use by another app (quit Fender Tone LT Desktop and try again)."
        case .openFailed(let r):
            return String(format: "Could not open the amp (IOReturn 0x%08x).", r)
        case .writeFailed(let r):
            return String(format: "USB write failed (IOReturn 0x%08x).", r)
        case .notOpen:
            return "The amp is not connected."
        }
    }
}

/// USB identifiers for the Fender LT family. The Mustang LT25 enumerates as 0x1ED8:0x0037.
public struct LTDeviceID: Hashable, Sendable {
    public let vendorID: Int
    public let productID: Int

    public static let fenderVendorID = 0x1ED8
    public static let mustangLT25 = LTDeviceID(vendorID: fenderVendorID, productID: 0x0037)

    /// The run-mode product IDs `fmic::LTMessageManager::enumerateDevices()` accepts.
    /// Bootloader (firmware-update) IDs are intentionally absent.
    public static let all: [LTDeviceID] = [0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x45, 0x46].map {
        LTDeviceID(vendorID: fenderVendorID, productID: $0)
    }
}

/// Talks raw 64-byte reports to the amp's vendor-defined HID interface (usage page 0xFF00).
public final class HIDTransport: @unchecked Sendable {
    public var onReport: ((Data) -> Void)?
    public var onRemoval: (() -> Void)?

    private var manager: IOHIDManager?
    private var device: IOHIDDevice?
    private var inputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: Framing.reportSize)
    private let writeQueue = DispatchQueue(label: "ToneLT.hid.write")
    private var thread: Thread?
    private var runLoop: CFRunLoop?

    public private(set) var productName: String = ""
    public private(set) var deviceID: LTDeviceID?

    public init() {}

    deinit {
        close()
        inputBuffer.deallocate()
    }

    /// Lists attached LT amps without opening them.
    public static func attachedDevices() -> [(id: LTDeviceID, name: String)] {
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        IOHIDManagerSetDeviceMatchingMultiple(manager, matchingDictionaries() as CFArray)
        guard let set = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice> else { return [] }
        return set.compactMap { dev in
            guard let id = deviceID(of: dev) else { return nil }
            return (id, stringProperty(dev, kIOHIDProductKey) ?? "Fender LT")
        }
    }

    private static func matchingDictionaries() -> [[String: Any]] {
        LTDeviceID.all.map {
            [
                kIOHIDVendorIDKey: $0.vendorID,
                kIOHIDProductIDKey: $0.productID,
                kIOHIDPrimaryUsagePageKey: 0xFF00,
            ]
        }
    }

    private static func deviceID(of device: IOHIDDevice) -> LTDeviceID? {
        guard let vid = IOHIDDeviceGetProperty(device, kIOHIDVendorIDKey as CFString) as? Int,
              let pid = IOHIDDeviceGetProperty(device, kIOHIDProductIDKey as CFString) as? Int
        else { return nil }
        return LTDeviceID(vendorID: vid, productID: pid)
    }

    private static func stringProperty(_ device: IOHIDDevice, _ key: String) -> String? {
        IOHIDDeviceGetProperty(device, key as CFString) as? String
    }

    /// Opens the first attached LT amp and starts delivering input reports on a private thread.
    public func open() throws {
        close()

        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        IOHIDManagerSetDeviceMatchingMultiple(manager, Self.matchingDictionaries() as CFArray)
        guard let devices = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice>,
              let device = devices.first
        else { throw TransportError.noDevice }

        let result = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
        if result == kIOReturnExclusiveAccess { throw TransportError.exclusiveAccess }
        guard result == kIOReturnSuccess else { throw TransportError.openFailed(result) }

        self.manager = manager
        self.device = device
        self.productName = Self.stringProperty(device, kIOHIDProductKey) ?? "Fender LT"
        self.deviceID = Self.deviceID(of: device)

        let ready = DispatchSemaphore(value: 0)
        let thread = Thread { [weak self] in
            guard let self else { return }
            self.runLoop = CFRunLoopGetCurrent()
            let context = Unmanaged.passUnretained(self).toOpaque()
            IOHIDDeviceRegisterInputReportCallback(
                device, self.inputBuffer, Framing.reportSize,
                { context, _, _, _, _, report, length in
                    guard let context else { return }
                    let transport = Unmanaged<HIDTransport>.fromOpaque(context).takeUnretainedValue()
                    transport.onReport?(Data(bytes: report, count: length))
                }, context)
            IOHIDDeviceRegisterRemovalCallback(device, { context, _, _ in
                guard let context else { return }
                Unmanaged<HIDTransport>.fromOpaque(context).takeUnretainedValue().onRemoval?()
            }, context)
            IOHIDDeviceScheduleWithRunLoop(device, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
            ready.signal()
            while !Thread.current.isCancelled {
                CFRunLoopRunInMode(.defaultMode, 0.25, false)
            }
            IOHIDDeviceUnscheduleFromRunLoop(device, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
        }
        thread.name = "ToneLT.hid.read"
        thread.qualityOfService = .userInitiated
        self.thread = thread
        thread.start()
        ready.wait()
    }

    public var isOpen: Bool { device != nil }

    public func close() {
        thread?.cancel()
        if let runLoop { CFRunLoopStop(runLoop) }
        thread = nil
        runLoop = nil
        if let device {
            IOHIDDeviceRegisterInputReportCallback(device, inputBuffer, Framing.reportSize, nil, nil)
            IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone))
        }
        device = nil
        manager = nil
    }

    /// Writes one 64-byte output report (the interface has no report IDs).
    public func write(report: Data) throws {
        guard let device else { throw TransportError.notOpen }
        var padded = [UInt8](report.prefix(Framing.reportSize))
        padded += [UInt8](repeating: 0, count: Framing.reportSize - padded.count)
        let result: IOReturn = writeQueue.sync {
            IOHIDDeviceSetReport(device, kIOHIDReportTypeOutput, 0, padded, padded.count)
        }
        guard result == kIOReturnSuccess else { throw TransportError.writeFailed(result) }
    }
}

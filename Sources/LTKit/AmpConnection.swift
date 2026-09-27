import Foundation

public enum AmpError: Error, CustomStringConvertible {
    case timeout(String)
    case rejected(String)
    case invalidPreset(String)
    case slotOutOfRange(Int)

    public var description: String {
        switch self {
        case .timeout(let what): "The amp did not answer (\(what))."
        case .rejected(let why): "The amp rejected the request: \(why)."
        case .invalidPreset(let why): "Invalid preset: \(why)."
        case .slotOutOfRange(let slot): "Preset slot \(slot) is out of range."
        }
    }
}

/// Owns the USB link: framing, heartbeat, and request/response matching.
public final class AmpConnection: @unchecked Sendable {
    public static let presetSlotCount = 60 // ToneDeviceLT::totalSlots()
    static let heartbeatInterval: TimeInterval = 1.0 // LTMessageManager heartbeat period

    public let transport = HIDTransport()

    /// Messages from the amp that did not answer one of our requests: knob turns on the
    /// amp, saves made from its panel, or replies to another program (HID read thread).
    public var onMessage: ((AmpMessage) -> Void)?
    public var onDisconnect: (() -> Void)?
    /// Optional wire log, e.g. for `ltctl --verbose`.
    public var log: ((String) -> Void)?

    private struct Waiter {
        let match: (AmpMessage) -> Bool
        let continuation: CheckedContinuation<AmpMessage, Error>
    }

    private let lock = NSLock()
    private let sendLock = NSLock()
    private var reassembler = Framing.Reassembler()
    private var waiters: [UUID: Waiter] = [:]
    private var heartbeat: DispatchSourceTimer?
    private var lastSend = Date.distantPast

    public init() {}

    public var isConnected: Bool { transport.isOpen }
    public var productName: String { transport.productName }

    public func open() throws {
        transport.onReport = { [weak self] in self?.handle(report: $0) }
        transport.onRemoval = { [weak self] in
            self?.teardown(error: TransportError.noDevice)
            self?.onDisconnect?()
        }
        try transport.open()
        startHeartbeat()
    }

    public func close() {
        teardown(error: TransportError.notOpen)
        transport.close()
    }

    private func teardown(error: Error) {
        heartbeat?.cancel()
        heartbeat = nil
        lock.lock()
        let pending = waiters.values
        waiters.removeAll()
        lock.unlock()
        pending.forEach { $0.continuation.resume(throwing: error) }
    }

    private func startHeartbeat() {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + Self.heartbeatInterval, repeating: Self.heartbeatInterval)
        timer.setEventHandler { [weak self] in
            guard let self, Date().timeIntervalSince(self.lastSend) >= Self.heartbeatInterval * 0.9 else { return }
            try? self.send(.heartbeat)
        }
        heartbeat = timer
        timer.resume()
    }

    /// Sends one message. All chunks of a message go out back to back.
    public func send(_ request: AmpRequest) throws {
        let payload = request.encoded()
        guard payload.count <= Framing.maxMessage else {
            throw AmpError.invalidPreset("message is \(payload.count) bytes; the amp accepts at most \(Framing.maxMessage)")
        }
        sendLock.lock()
        defer { sendLock.unlock() }
        if request != .heartbeat { log?("→ \(request.logDescription) (\(payload.count) bytes)") }
        for report in Framing.reports(for: payload) {
            try transport.write(report: report)
        }
        lastSend = Date()
    }

    /// Sends a request and waits for the first message accepted by `match`.
    public func request(
        _ request: AmpRequest,
        timeout: TimeInterval = 3,
        match: @escaping (AmpMessage) -> Bool
    ) async throws -> AmpMessage {
        let id = UUID()
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            waiters[id] = Waiter(match: match, continuation: continuation)
            lock.unlock()
            do {
                try send(request)
            } catch {
                resolve(id, with: .failure(error))
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.resolve(id, with: .failure(AmpError.timeout(request.logDescription)))
            }
        }
    }

    private func resolve(_ id: UUID, with result: Result<AmpMessage, Error>) {
        lock.lock()
        let waiter = waiters.removeValue(forKey: id)
        lock.unlock()
        waiter?.continuation.resume(with: result)
    }

    private func handle(report: Data) {
        lock.lock()
        let payload = reassembler.feed(report)
        lock.unlock()
        guard let payload else { return }

        let message: AmpMessage
        do {
            message = try AmpMessage.decode(payload)
        } catch {
            log?("← undecodable message: \(payload.map { String(format: "%02x", $0) }.joined())")
            return
        }
        if message != .heartbeat { log?("← \(message.logDescription)") }

        lock.lock()
        let matched = waiters.first { $0.value.match(message) }
        if let matched { waiters.removeValue(forKey: matched.key) }
        lock.unlock()
        if let matched {
            matched.value.continuation.resume(returning: message)
        } else {
            onMessage?(message)
        }
    }
}

extension AmpRequest {
    var logDescription: String {
        switch self {
        case .auditionPreset(let json): "auditionPreset(\(json.count) chars)"
        case .savePresetAs(let json, let slot, let load): "savePresetAs(slot: \(slot), load: \(load), \(json.count) chars)"
        default: "\(self)"
        }
    }
}

extension AmpMessage {
    var logDescription: String {
        switch self {
        case .presetJSON(let json, let slot): "presetJSON(slot: \(slot), \(json.count) chars)"
        case .currentPreset(let json, let slot, let dirty): "currentPreset(slot: \(slot), dirty: \(dirty), \(json.count) chars)"
        case .newPresetSaved(let json, let slot): "newPresetSaved(slot: \(slot), \(json.count) chars)"
        case .auditionPresetStatus(let json): "auditionPresetStatus(\(json.count) chars)"
        default: "\(self)"
        }
    }
}

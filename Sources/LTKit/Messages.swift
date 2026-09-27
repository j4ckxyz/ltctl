import Foundation

// Field numbers come from the FenderMessageLT.proto descriptor embedded in
// Fender Tone LT Desktop 1.5.0 (see docs/PROTOCOL.md).

public enum ModalContext: Int, Sendable {
    case syncBegin = 0, syncEnd, backupBegin, backupEnd, restoreBegin, restoreEnd
    case tunerEnable, tunerDisable, factoryRestoreBegin, factoryRestoreEnd
    case toneBusyBegin, toneBusyEnd
}

public enum ModalState: Int, Sendable {
    case ok = 0, fail
}

public enum AmpErrorType: Int, Sendable {
    case unsupported = 0, failed, invalidParam, invalidNodeId, paramOutOfBounds, factoryRestoreInProgress
}

/// Host → amp messages. Deliberately limited to messages Fender Tone LT Desktop
/// itself sends; firmware flashing, factory restore and QA-slot writes are not exposed.
public enum AmpRequest: Equatable, Sendable {
    case heartbeat
    case connectionStatus
    case modalStatus(ModalContext, ModalState)
    case firmwareVersion
    case productIdentification
    case retrievePreset(slot: Int)
    case currentPreset
    case loadPreset(slot: Int)
    case qaSlots
    case auditionPreset(json: String)
    case exitAudition
    case auditionState
    case savePresetAs(json: String, slot: Int, load: Bool)

    var field: Int {
        switch self {
        case .heartbeat: 201
        case .connectionStatus: 202
        case .modalStatus: 113
        case .firmwareVersion: 102
        case .productIdentification: 101
        case .retrievePreset: 105
        case .currentPreset: 104
        case .loadPreset: 33
        case .qaSlots: 108
        case .auditionPreset: 58
        case .exitAudition: 60
        case .auditionState: 62
        case .savePresetAs: 55
        }
    }

    /// Serialized FenderMessageLT protobuf.
    public func encoded() -> Data {
        var w = ProtoWriter()
        w.int32(1, 0) // responseType = UNSOLICITED
        w.message(field) { m in
            switch self {
            case .heartbeat:
                m.bool(1, true)
            case .connectionStatus, .firmwareVersion, .productIdentification,
                 .currentPreset, .qaSlots, .auditionState:
                m.bool(1, true)
            case .modalStatus(let context, let state):
                m.int32(1, Int32(context.rawValue))
                m.int32(2, Int32(state.rawValue))
            case .retrievePreset(let slot), .loadPreset(let slot):
                m.int32(1, Int32(slot))
            case .auditionPreset(let json):
                m.string(1, json)
            case .exitAudition:
                m.bool(1, true)
            case .savePresetAs(let json, let slot, let load):
                m.string(1, json)
                m.bool(2, load)
                m.int32(3, Int32(slot))
            }
        }
        return w.data
    }
}

/// Amp → host messages the app cares about.
public enum AmpMessage: Equatable, Sendable {
    case connectionStatus(Bool)
    case heartbeat
    case modalStatus(context: Int, state: Int)
    case firmwareVersion(String)
    case productIdentification(String)
    case presetJSON(json: String, slot: Int)
    case currentPreset(json: String, slot: Int, dirty: Bool)
    case currentLoadedPresetIndex(Int)
    case currentDisplayedPresetIndex(Int)
    case presetEdited(Bool)
    case presetSaved(name: String, slot: Int)
    case newPresetSaved(json: String, slot: Int)
    case auditionPresetStatus(json: String)
    case exitAuditionStatus(Bool)
    case auditionState(Bool)
    case qaSlots([Int])
    case usbGain(Float)
    case unsupported(Int)
    case other(field: Int)

    public static func decode(_ data: Data) throws -> AmpMessage {
        let top = try ProtoFields(data)
        guard let (field, value) = top.entries.first(where: { $0.field != 1 }) else {
            return .other(field: 0)
        }
        guard case .lengthDelimited(let body) = value else { return .other(field: field) }
        let m = try ProtoFields(body)
        switch field {
        case 203: return .connectionStatus(m.bool(1) ?? false)
        case 201: return .heartbeat
        case 113: return .modalStatus(context: m.int(1) ?? -1, state: m.int(2) ?? -1)
        case 103: return .firmwareVersion(m.string(1) ?? "")
        case 100: return .productIdentification(m.string(1) ?? "")
        case 31: return .presetJSON(json: m.string(1) ?? "", slot: m.int(2) ?? -1)
        case 32: return .currentPreset(json: m.string(1) ?? "", slot: m.int(2) ?? -1, dirty: m.bool(3) ?? false)
        case 37: return .currentLoadedPresetIndex(m.int(1) ?? -1)
        case 47: return .currentDisplayedPresetIndex(m.int(1) ?? -1)
        case 38: return .presetEdited(m.bool(1) ?? false)
        case 50: return .presetSaved(name: m.string(1) ?? "", slot: m.int(2) ?? -1)
        case 56: return .newPresetSaved(json: m.string(1) ?? "", slot: m.int(2) ?? -1)
        case 59: return .auditionPresetStatus(json: m.string(1) ?? "")
        case 61: return .exitAuditionStatus(m.bool(1) ?? false)
        case 63: return .auditionState(m.bool(1) ?? false)
        case 109: return .qaSlots(m.repeatedVarints(1).map { Int($0) })
        case 107: return .usbGain(m.float(1) ?? 0)
        case 200: return .unsupported(m.int(1) ?? -1)
        default: return .other(field: field)
        }
    }
}

/// Splits protobuf payloads into 64-byte HID reports and reassembles them.
///
/// Each report is `[tag, length, payload…]` zero-padded to 64 bytes, where tag is
/// 0x33 (first of several), 0x34 (continuation) or 0x35 (last / only).
public enum Framing {
    public static let reportSize = 64
    public static let maxChunk = 61
    public static let maxMessage = 4000 // FenderMessageLTEncoder MTU

    public enum Tag: UInt8 {
        case first = 0x33, middle = 0x34, last = 0x35
    }

    public static func reports(for payload: Data) -> [Data] {
        let bytes = [UInt8](payload)
        var chunks: [ArraySlice<UInt8>] = stride(from: 0, to: bytes.count, by: maxChunk).map {
            bytes[$0..<min($0 + maxChunk, bytes.count)]
        }
        if chunks.isEmpty { chunks = [[]] }
        return chunks.enumerated().map { index, chunk in
            let tag: Tag = index == chunks.count - 1 ? .last : (index == 0 ? .first : .middle)
            var report = [tag.rawValue, UInt8(chunk.count)] + chunk
            report += [UInt8](repeating: 0, count: reportSize - report.count)
            return Data(report)
        }
    }

    public struct Reassembler {
        private var buffer = Data()
        private var inMessage = false

        public init() {}

        /// Feed one input report; returns a complete payload when the last chunk arrives.
        public mutating func feed(_ report: Data) -> Data? {
            var bytes = [UInt8](report)
            // Input reports from the amp arrive with a leading 0x00 before the tag.
            if bytes.first == 0, bytes.count > 1, Tag(rawValue: bytes[1]) != nil {
                bytes.removeFirst()
            }
            guard bytes.count >= 2, let tag = Tag(rawValue: bytes[0]) else { return nil }
            let length = min(Int(bytes[1]), bytes.count - 2)
            let chunk = Data(bytes[2..<2 + length])
            switch tag {
            case .first:
                buffer = chunk
                inMessage = true
                return nil
            case .middle:
                guard inMessage else { return nil }
                buffer.append(chunk)
                return nil
            case .last:
                defer { buffer = Data(); inMessage = false }
                return inMessage ? buffer + chunk : chunk
            }
        }
    }
}

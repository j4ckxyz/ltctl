import Foundation

public struct AmpInfo: Sendable, Equatable {
    public var usbName: String
    public var productId: String
    public var firmware: String

    /// "mustang-lt-25" → "Mustang LT25"
    public var modelName: String {
        switch productId {
        case "mustang-lt-25": "Mustang LT25"
        case "mustang-lt-40s": "Mustang LT40S"
        case "mustang-lt-50": "Mustang LT50"
        case "rumble-lt-25": "Rumble LT25"
        default: usbName
        }
    }
}

/// High-level amp operations, mirroring what Fender Tone LT Desktop does.
public final class AmpClient: @unchecked Sendable {
    public let connection = AmpConnection()
    public private(set) var info: AmpInfo?

    public init() {}

    public var onMessage: ((AmpMessage) -> Void)? {
        get { connection.onMessage }
        set { connection.onMessage = newValue }
    }

    public var onDisconnect: (() -> Void)? {
        get { connection.onDisconnect }
        set { connection.onDisconnect = newValue }
    }

    /// Opens USB and performs the handshake: SYNC_BEGIN, then identity queries.
    /// The amp answers nothing but connection status until SYNC_BEGIN has been sent.
    @discardableResult
    public func connect() async throws -> AmpInfo {
        try connection.open()
        do {
            _ = try await connection.request(.modalStatus(.syncBegin, .ok)) {
                if case .modalStatus(ModalContext.syncBegin.rawValue, _) = $0 { true } else { false }
            }
            let firmware = try await connection.request(.firmwareVersion) {
                if case .firmwareVersion = $0 { true } else { false }
            }
            let product = try await connection.request(.productIdentification) {
                if case .productIdentification = $0 { true } else { false }
            }
            guard case .firmwareVersion(let fw) = firmware, case .productIdentification(let pid) = product else {
                throw AmpError.rejected("unexpected identity response")
            }
            let info = AmpInfo(usbName: connection.productName, productId: pid, firmware: fw)
            self.info = info
            return info
        } catch {
            connection.close()
            throw error
        }
    }

    /// Ends the sync phase started by `connect()` (Fender Tone does this once presets are loaded).
    public func finishSync() async throws {
        _ = try await connection.request(.modalStatus(.syncEnd, .ok)) {
            if case .modalStatus(ModalContext.syncEnd.rawValue, _) = $0 { true } else { false }
        }
    }

    public func disconnect() {
        connection.close()
        info = nil
    }

    /// Record reads and writes in `PresetCache` (for `ltctl --cached`).
    public var updatesCache = true

    /// Reads one slot (1-based).
    public func readPreset(slot: Int) async throws -> Preset {
        let preset = try await fetchPreset(slot: slot)
        cache([preset])
        return preset
    }

    /// One RetrievePreset round trip. Reads change nothing, so a lost request is retried once.
    private func fetchPreset(slot: Int) async throws -> Preset {
        try checkSlot(slot)
        var attempt = 0
        while true {
            do {
                let message = try await connection.request(.retrievePreset(slot: slot), timeout: 1.5) {
                    if case .presetJSON(_, slot) = $0 { true } else { false }
                }
                guard case .presetJSON(let json, _) = message else { throw AmpError.timeout("preset \(slot)") }
                return try Preset(json: json, slot: slot)
            } catch AmpError.timeout where attempt == 0 {
                attempt += 1
            }
        }
    }

    private func cache(_ presets: [Preset]) {
        guard updatesCache, let productId = info?.productId else { return }
        PresetCache.store(presets, productId: productId)
    }

    public func readAllPresets(progress: ((Int, Int) -> Void)? = nil) async throws -> [Preset] {
        let total = AmpConnection.presetSlotCount
        var done = 0
        return try await readPresets(slots: Array(1...total)) { _ in
            done += 1
            progress?(done, total)
        }
    }

    /// Reads several slots with up to `window` requests in flight, returning them in the
    /// order given. `onEach` fires as each preset arrives (in slot order).
    public func readPresets(
        slots: [Int],
        window: Int = AmpClient.defaultReadWindow,
        onEach: ((Preset) -> Void)? = nil
    ) async throws -> [Preset] {
        try slots.forEach(checkSlot)
        guard !slots.isEmpty else { return [] }
        let window = max(1, window)
        return try await withThrowingTaskGroup(of: (Int, Preset).self) { group in
            var results: [Int: Preset] = [:]
            var next = 0
            var emitted = 0
            func launch() {
                let index = next
                let slot = slots[index]
                next += 1
                group.addTask { (index, try await self.fetchPreset(slot: slot)) }
            }
            while next < min(window, slots.count) { launch() }
            while let (index, preset) = try await group.next() {
                results[index] = preset
                while let ready = results[emitted], emitted < slots.count {
                    onEach?(ready)
                    emitted += 1
                    if emitted == slots.count { break }
                }
                if next < slots.count { launch() }
            }
            let presets = (0..<slots.count).map { results[$0]! }
            cache(presets)
            return presets
        }
    }

    /// Requests in flight while reading many slots. On a Mustang LT25 two in flight save ~6%
    /// (2.25 s vs 2.39 s for all 60, bound by 64-byte full-speed USB reports); eight in flight
    /// makes the amp drop requests.
    public static let defaultReadWindow = 2

    /// The amp's active preset slot and whether it has unsaved knob changes.
    public func currentPreset() async throws -> (slot: Int, dirty: Bool, preset: Preset) {
        let message = try await connection.request(.currentPreset) {
            if case .currentPreset = $0 { true } else { false }
        }
        guard case .currentPreset(let json, let slot, let dirty) = message else { throw AmpError.timeout("current preset") }
        return (slot, dirty, try Preset(json: json, slot: slot))
    }

    /// Switches the amp to a stored preset (what clicking a preset does in Fender Tone).
    public func loadPreset(slot: Int) async throws {
        try checkSlot(slot)
        _ = try await connection.request(.loadPreset(slot: slot)) {
            switch $0 {
            case .currentLoadedPresetIndex(slot), .currentPreset(_, slot, _): true
            default: false
            }
        }
    }

    /// Stores a preset into a slot, replacing what is there (Fender Tone's "Paste Preset" /
    /// "Duplicate Preset to My Amp" message). Returns the preset as the amp now reports it.
    public func writePreset(json: String, slot: Int, load: Bool = false) async throws -> Preset {
        try checkSlot(slot)
        let payload = Self.wireJSON(json)
        _ = try Preset(json: payload, slot: slot)
        let reply = try await connection.request(.savePresetAs(json: payload, slot: slot, load: load), timeout: 5) {
            switch $0 {
            case .presetSaved(_, slot), .newPresetSaved(_, slot), .unsupported: true
            default: false
            }
        }
        if case .unsupported(let code) = reply {
            throw AmpError.rejected(AmpErrorType(rawValue: code).map { "\($0)" } ?? "error \(code)")
        }
        return try await readPreset(slot: slot)
    }

    /// Plays a preset without storing it (Fender Tone's factory-preset "Auto-Audition").
    public func audition(json: String) async throws {
        _ = try await connection.request(.auditionPreset(json: Self.wireJSON(json))) {
            switch $0 {
            case .auditionPresetStatus, .unsupported: true
            default: false
            }
        }
    }

    /// Leaves audition mode. The amp keeps playing the auditioned sound as an unsaved edit of
    /// the active slot after ExitAuditionPreset, so the stored preset is reloaded afterwards.
    public func exitAudition() async throws {
        _ = try await connection.request(.exitAudition) {
            switch $0 {
            case .exitAuditionStatus, .unsupported: true
            default: false
            }
        }
        let current = try await currentPreset()
        try await loadPreset(slot: current.slot)
    }

    /// Sends preset JSON exactly as given (so exported files round-trip byte for byte),
    /// minifying only when whitespace would push it past the amp's message limit.
    static func wireJSON(_ json: String) -> String {
        let trimmed = json.trimmingCharacters(in: .whitespacesAndNewlines)
        let size = AmpRequest.savePresetAs(json: trimmed, slot: 1, load: false).encoded().count
        return size <= Framing.maxMessage ? trimmed : PresetJSON.minified(trimmed)
    }

    private func checkSlot(_ slot: Int) throws {
        guard (1...AmpConnection.presetSlotCount).contains(slot) else { throw AmpError.slotOutOfRange(slot) }
    }
}

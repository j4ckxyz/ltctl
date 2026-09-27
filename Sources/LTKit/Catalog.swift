import Foundation

/// A preset parameter value as it appears in preset JSON.
public enum ParamValue: Equatable, Sendable, CustomStringConvertible {
    case number(Double)
    case bool(Bool)
    case string(String)

    init?(_ any: Any) {
        if let n = any as? NSNumber {
            // JSONSerialization represents booleans as CFBoolean-backed NSNumbers.
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                self = .bool(n.boolValue)
            } else {
                self = .number(n.doubleValue)
            }
        } else if let s = any as? String {
            self = .string(s)
        } else {
            return nil
        }
    }

    public var description: String {
        switch self {
        case .number(let d): formatNumber(d)
        case .bool(let b): b ? "true" : "false"
        case .string(let s): "\"\(s)\""
        }
    }

    public var number: Double? {
        if case .number(let d) = self { return d }
        return nil
    }
}

func formatNumber(_ d: Double) -> String {
    if d == d.rounded(), abs(d) < 1e9 { return String(Int(d)) }
    var s = String(format: "%.6f", d)
    while s.hasSuffix("0") { s.removeLast() }
    return s
}

/// The five fixed positions of an LT signal chain, in signal order.
public enum ChainSlot: String, CaseIterable, Sendable {
    case stomp, mod, amp, delay, reverb

    public var title: String {
        switch self {
        case .stomp: "Stomp"
        case .mod: "Mod"
        case .amp: "Amp"
        case .delay: "Delay"
        case .reverb: "Reverb"
        }
    }

    /// Where the official app draws the node: PRE FX, AMP or POST FX.
    public var section: String {
        switch self {
        case .stomp, .mod: "Pre FX"
        case .amp: "Amp"
        case .delay, .reverb: "Post FX"
        }
    }
}

public struct ParamSpec: Sendable {
    public enum Kind: String, Sendable {
        case continuous, list, listBool
    }

    public struct Remap: Sendable {
        public var min: Double?
        public var max: Double?
        public var taper: Taper
        public var format: String?
        /// nil when the definition has no remap units; "" when it explicitly has none.
        public var units: String?
        public var listItems: [String]
    }

    /// Units of the stored value. Definitions put `units` on the parameter even when it
    /// describes the display (e.g. delay time: stored in seconds, shown in ms).
    public var rawUnits: String? {
        remap == nil || remap?.units != nil ? units : nil
    }

    /// Units of the value Fender Tone shows.
    public var displayUnits: String? {
        let u = remap?.units ?? units
        return u?.isEmpty == true ? nil : u
    }

    public var id: String
    public var displayName: String
    public var kind: Kind
    public var units: String?
    public var min: Double?
    public var max: Double?
    public var taper: Taper
    public var taperName: String?
    public var remap: Remap?
    public var remapTaperName: String?
    public var listItems: [String]
    /// Shown on the Mustang LT's own panel/UI (as opposed to only in the GT-level editor definition).
    public var onLTPanel: Bool

    init?(_ dict: [String: Any], onLTPanel: Bool) {
        guard let id = dict["controlId"] as? String else { return nil }
        self.id = id
        displayName = (dict["paramGuiObjectNameMaximized"] as? String) ?? (dict["displayName"] as? String) ?? id
        kind = Kind(rawValue: dict["controlType"] as? String ?? "") ?? .continuous
        units = (dict["units"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        min = (dict["min"] as? NSNumber)?.doubleValue
        max = (dict["max"] as? NSNumber)?.doubleValue
        taperName = dict["taper"] as? String
        taper = Taper(name: taperName)
        listItems = dict["listItems"] as? [String] ?? []
        self.onLTPanel = onLTPanel
        if let r = dict["remap"] as? [String: Any] {
            remapTaperName = r["taper"] as? String
            remap = Remap(
                min: (r["min"] as? NSNumber)?.doubleValue,
                max: (r["max"] as? NSNumber)?.doubleValue,
                taper: Taper(name: r["taper"] as? String),
                format: r["format"] as? String,
                units: r["units"] as? String,
                listItems: r["listItems"] as? [String] ?? []
            )
        }
    }

    /// Converts a stored (raw) value to what the official app shows, e.g. 0.5 → "5.5".
    public func displayString(for value: ParamValue) -> String {
        switch (kind, value) {
        case (.list, .string(let s)):
            if let i = listItems.firstIndex(of: s), let labels = remap?.listItems, i < labels.count {
                return labels[i]
            }
            return s
        case (.listBool, .bool(let b)):
            if let labels = remap?.listItems, labels.count == 2 { return labels[b ? 1 : 0] }
            return b ? "On" : "Off"
        case (.continuous, .number(let raw)):
            guard let display = displayValue(raw: raw) else { return formatNumber(raw) }
            var text = format(display)
            if let u = displayUnits { text += " \(u)" }
            return text
        default:
            return value.description
        }
    }

    /// Display value for a raw value, following remap/taper (display = remap(taper⁻¹(raw))).
    public func displayValue(raw: Double) -> Double? {
        guard let min, let max, max != min else { return nil }
        guard let remap, let rmin = remap.min, let rmax = remap.max else { return raw }
        let fraction = Swift.min(Swift.max((raw - min) / (max - min), 0), 1)
        return rmin + (rmax - rmin) * remap.taper.calc(fraction)
    }

    /// Raw value to store for a desired display value (the inverse of `displayValue`).
    public func rawValue(display: Double) -> Double? {
        guard let min, let max else { return nil }
        guard let remap, let rmin = remap.min, let rmax = remap.max, rmax != rmin else { return display }
        let position = Swift.min(Swift.max((display - rmin) / (rmax - rmin), 0), 1)
        return min + (max - min) * remap.taper.invert(position)
    }

    private func format(_ v: Double) -> String {
        String(format: remap?.format ?? "%.1f", v).trimmingCharacters(in: .whitespaces)
    }
}

public struct DSPUnitSpec: Sendable {
    public var fenderId: String
    public var displayName: String
    public var subcategory: String
    public var hasBypass: Bool
    public var hasTap: Bool
    public var tapParameter: String?
    public var defaults: [String: ParamValue]
    public var params: [ParamSpec]

    public func param(_ id: String) -> ParamSpec? { params.first { $0.id == id } }

    init?(lt: [String: Any], advanced: [String: Any]?) {
        guard let fenderId = lt["FenderId"] as? String else { return nil }
        self.fenderId = fenderId
        let info = lt["info"] as? [String: Any] ?? [:]
        displayName = info["displayName"] as? String ?? fenderId
        subcategory = info["subcategory"] as? String ?? ""
        let ui = lt["ui"] as? [String: Any] ?? [:]
        hasBypass = ui["hasBypass"] as? Bool ?? false
        hasTap = ui["hasTap"] as? Bool ?? false
        tapParameter = ui["tapParameter"] as? String
        defaults = (lt["defaultDspUnitParameters"] as? [String: Any] ?? [:]).compactMapValues(ParamValue.init)

        var params = (ui["uiParameters"] as? [[String: Any]] ?? []).compactMap { ParamSpec($0, onLTPanel: true) }
        let known = Set(params.map(\.id))
        let advancedUI = (advanced?["ui"] as? [String: Any])?["uiParameters"] as? [[String: Any]] ?? []
        params += advancedUI.compactMap { ParamSpec($0, onLTPanel: false) }.filter { !known.contains($0.id) }
        self.params = params
    }
}

/// Everything `ltctl setup` extracts from Fender Tone LT Desktop (catalog.json).
public struct Catalog: Sendable {
    public var source: String
    public var units: [String: DSPUnitSpec]
    /// Units selectable in each chain slot, in the amp's menu order, with the amp's menu label.
    public var options: [ChainSlot: [(fenderId: String, menuName: String)]]
    public var emptyPresetJSON: String
    public var factoryPresets: [Preset]

    public func unit(_ fenderId: String) -> DSPUnitSpec? { units[fenderId] }

    public func menuName(_ fenderId: String) -> String? {
        for list in options.values {
            if let hit = list.first(where: { $0.fenderId == fenderId }) { return hit.menuName }
        }
        return nil
    }

    public init(data: Data) throws {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AmpError.invalidPreset("catalog is not a JSON object")
        }
        source = root["source"] as? String ?? "unknown"
        let lt = root["dspUnits"] as? [String: [String: Any]] ?? [:]
        let advanced = root["advancedDspUnits"] as? [String: [String: Any]] ?? [:]
        units = lt.compactMapValues { DSPUnitSpec(lt: $0, advanced: advanced[$0["FenderId"] as? String ?? ""]) }

        var options: [ChainSlot: [(String, String)]] = [:]
        let profile = root["productProfile"] as? [String: Any] ?? [:]
        func entries(_ any: Any?) -> [(String, String)] {
            (any as? [[String: Any]] ?? []).compactMap {
                guard let id = $0["FenderId"] as? String else { return nil }
                return (id, $0["menuName18Max"] as? String ?? id)
            }
        }
        for category in profile["effectCategories"] as? [[String: Any]] ?? [] {
            if let slot = ChainSlot(rawValue: category["categoryName"] as? String ?? "") {
                options[slot] = entries(category["dspUnits"])
            }
        }
        options[.amp] = entries((profile["amp"] as? [String: Any])?["dspUnits"])
        self.options = options.mapValues { $0.map { (fenderId: $0.0, menuName: $0.1) } }

        func jsonString(_ any: Any?) -> String? {
            guard let any, let d = try? JSONSerialization.data(withJSONObject: any) else { return nil }
            return String(decoding: d, as: UTF8.self)
        }
        emptyPresetJSON = jsonString(root["emptyPreset"]) ?? ""
        factoryPresets = (root["factoryPresets"] as? [Any] ?? []).compactMap {
            jsonString($0).flatMap { try? Preset(json: $0, slot: nil) }
        }.sorted { $0.displayName < $1.displayName }
    }

    /// Looks for catalog.json in the app bundle, next to the executable, in
    /// ~/Library/Application Support/ToneLT, or at $TONELT_CATALOG.
    public static func load() -> Catalog? {
        var candidates: [URL] = []
        if let env = ProcessInfo.processInfo.environment["TONELT_CATALOG"] {
            candidates.append(URL(fileURLWithPath: env))
        }
        if let r = Bundle.main.url(forResource: "catalog", withExtension: "json") { candidates.append(r) }
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
        candidates.append(exe.appendingPathComponent("catalog.json"))
        candidates.append(exe.appendingPathComponent("../Resources/catalog.json"))
        candidates.append(Storage.supportDirectory.appendingPathComponent("catalog.json"))
        for url in candidates {
            if let data = try? Data(contentsOf: url), let catalog = try? Catalog(data: data) {
                return catalog
            }
        }
        return nil
    }
}

import Foundation

public struct PresetNode: Sendable, Identifiable {
    public var id: String { nodeId }
    public var nodeId: String
    public var fenderId: String
    public var params: [String: ParamValue]

    public var slot: ChainSlot? { ChainSlot(rawValue: nodeId) }
    public var isEmpty: Bool { fenderId == "DUBS_Passthru" }
    public var isBypassed: Bool { params["bypass"] == .bool(true) }
}

/// One preset: the amp's JSON (kept byte-for-byte) plus a parsed view of it.
public struct Preset: Sendable, Identifiable {
    public var id: String { slot.map { "slot-\($0)" } ?? "\(rawName)-\(json.hashValue)" }
    /// 1-based amp slot, or nil for presets not on the amp (files, factory library).
    public var slot: Int?
    public var json: String
    /// 16-character amp name: two 8-character fields, e.g. "FENDER  CLEAN   ".
    public var rawName: String
    public var productId: String
    public var isFactoryDefault: Bool
    public var nodes: [PresetNode]

    public var displayName: String { Self.displayName(fromAmpName: rawName) }
    public var isEmptySlot: Bool { rawName.trimmingCharacters(in: .whitespaces) == "EMPTY" }

    public func node(_ slot: ChainSlot) -> PresetNode? { nodes.first { $0.nodeId == slot.rawValue } }

    public init(json: String, slot: Int?) throws {
        guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let root = object as? [String: Any]
        else { throw AmpError.invalidPreset("not valid JSON") }
        guard root["nodeType"] as? String == "preset" else {
            throw AmpError.invalidPreset("missing \"nodeType\": \"preset\"")
        }
        guard let graph = root["audioGraph"] as? [String: Any],
              let nodes = graph["nodes"] as? [[String: Any]]
        else { throw AmpError.invalidPreset("missing audioGraph.nodes") }

        let info = root["info"] as? [String: Any] ?? [:]
        self.slot = slot
        self.json = json
        rawName = info["displayName"] as? String ?? ""
        productId = info["product_id"] as? String ?? ""
        isFactoryDefault = info["is_factory_default"] as? Bool ?? false
        self.nodes = nodes.map {
            PresetNode(
                nodeId: $0["nodeId"] as? String ?? "",
                fenderId: $0["FenderId"] as? String ?? "",
                params: ($0["dspUnitParameters"] as? [String: Any] ?? [:]).compactMapValues(ParamValue.init)
            )
        }
    }

    /// "JAZZ       AMP  " → "Jazz Amp" (how Fender Tone shows names).
    public static func displayName(fromAmpName name: String) -> String {
        let chars = Array(name)
        let fields = [chars.prefix(8), chars.dropFirst(8).prefix(8)].map {
            String($0).trimmingCharacters(in: .whitespaces)
        }
        let joined = fields.filter { !$0.isEmpty }.joined(separator: " ")
        return joined.split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }

    /// A filesystem-friendly name for exports, e.g. "01 Fender Clean".
    public var fileBaseName: String {
        let name = displayName.isEmpty ? "Preset" : displayName
        let safe = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        return slot.map { String(format: "%02d %@", $0, safe) } ?? safe
    }

    /// Checks a preset against what the amp accepts before it is written.
    public func validate(catalog: Catalog?) -> [String] {
        var problems: [String] = []
        if rawName.count > 16 { problems.append("name \"\(rawName)\" is longer than 16 characters") }
        if !productId.isEmpty, productId != "mustang-lt" {
            problems.append("preset is for \"\(productId)\", not a Mustang LT")
        }
        let ids = Set(nodes.map(\.nodeId))
        for slot in ChainSlot.allCases where !ids.contains(slot.rawValue) {
            problems.append("missing the \"\(slot.rawValue)\" node")
        }
        for node in nodes where node.isBypassed && !node.isEmpty {
            problems.append("\(node.nodeId) has \"bypass\": true, which the amp doesn't store; use DUBS_Passthru to leave the effect out")
        }
        if let catalog {
            for node in nodes {
                guard let slot = node.slot, let allowed = catalog.options[slot] else { continue }
                if !allowed.contains(where: { $0.fenderId == node.fenderId }) {
                    problems.append("\(node.fenderId) is not available in the \(slot.rawValue) slot on a Mustang LT")
                }
            }
        }
        let size = AmpRequest.savePresetAs(json: PresetJSON.minified(json), slot: 1, load: false).encoded().count
        if size > Framing.maxMessage {
            problems.append("preset is too large to send (\(size) bytes, limit \(Framing.maxMessage))")
        }
        return problems
    }
}

public enum PresetJSON {
    /// Removes insignificant whitespace without re-encoding values, so numbers and key order are untouched.
    public static func minified(_ json: String) -> String {
        var out = ""
        out.reserveCapacity(json.count)
        var inString = false
        var escaped = false
        for c in json {
            if inString {
                out.append(c)
                if escaped { escaped = false } else if c == "\\" { escaped = true } else if c == "\"" { inString = false }
            } else if c == "\"" {
                inString = true
                out.append(c)
            } else if !c.isWhitespace {
                out.append(c)
            }
        }
        return out
    }

    /// Pretty-printed copy for human-edited files (values re-encoded by JSONSerialization).
    public static func prettyPrinted(_ json: String) -> String {
        guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        else { return json }
        return String(decoding: data, as: UTF8.self)
    }
}

import Foundation

/// The last-known contents of each amp slot, refreshed whenever ltctl or ToneLT reads or
/// writes a slot. Lets `ltctl list --cached` answer instantly without USB.
public enum PresetCache {
    public struct Entry: Codable, Sendable {
        public var json: String
        public var readAt: Date
    }

    struct File: Codable {
        var productId: String
        var slots: [String: Entry]
    }

    public static var url: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("ToneLT/presets.json")
    }

    private static func read() -> File? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return try? decoder.decode(File.self, from: data)
    }

    /// Records presets just read from (or written to) the amp.
    public static func store(_ presets: [Preset], productId: String) {
        let now = Date()
        var file = read() ?? File(productId: productId, slots: [:])
        if file.productId != productId { file = File(productId: productId, slots: [:]) }
        for preset in presets {
            guard let slot = preset.slot else { continue }
            file.slots[String(slot)] = Entry(json: preset.json, readAt: now)
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        guard let data = try? encoder.encode(file) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    /// Cached presets by slot, with the time each was last read.
    public static func load() -> (productId: String, presets: [Int: (preset: Preset, readAt: Date)]) {
        guard let file = read() else { return ("", [:]) }
        var out: [Int: (Preset, Date)] = [:]
        for (key, entry) in file.slots {
            if let slot = Int(key), let preset = try? Preset(json: entry.json, slot: slot) {
                out[slot] = (preset, entry.readAt)
            }
        }
        return (file.productId, out.mapValues { (preset: $0.0, readAt: $0.1) })
    }
}

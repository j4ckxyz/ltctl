import Foundation

/// Preset files and automatic backups.
///
/// `.preset` files hold the preset JSON exactly as the amp stores it, the same thing
/// Fender Tone LT Desktop's "Export Preset" writes (SignalChainModel::serializeToString).
public enum Storage {
    public static let presetExtension = "preset"

    public static var supportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("ToneLT", isDirectory: true)
    }

    public static var backupDirectory: URL {
        supportDirectory.appendingPathComponent("Backups", isDirectory: true)
    }

    public static func readPresetFile(_ url: URL) throws -> Preset {
        let text = try String(contentsOf: url, encoding: .utf8)
        return try Preset(json: text.trimmingCharacters(in: .whitespacesAndNewlines), slot: nil)
    }

    public static func write(_ preset: Preset, to url: URL) throws {
        try Data(preset.json.utf8).write(to: url, options: .atomic)
    }

    /// Writes every preset into `directory` as "NN Name.preset"; returns the files written.
    @discardableResult
    public static func exportAll(_ presets: [Preset], to directory: URL) throws -> [URL] {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return try presets.map { preset in
            let url = directory.appendingPathComponent(preset.fileBaseName).appendingPathExtension(presetExtension)
            try write(preset, to: url)
            return url
        }
    }

    /// Saves the preset currently in a slot before it gets overwritten.
    @discardableResult
    public static func backup(_ preset: Preset, reason: String) throws -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HHmmss"
        let dir = backupDirectory.appendingPathComponent(formatter.string(from: Date()) + " " + reason, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(preset.fileBaseName).appendingPathExtension(presetExtension)
        try write(preset, to: url)
        return url
    }

    /// Snapshot of the whole amp, taken on each connect so nothing is ever unrecoverable.
    @discardableResult
    public static func snapshot(_ presets: [Preset], label: String) throws -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HHmmss"
        let dir = backupDirectory.appendingPathComponent("\(formatter.string(from: Date())) \(label)", isDirectory: true)
        try exportAll(presets, to: dir)
        pruneSnapshots(keeping: 20, label: label)
        return dir
    }

    private static func pruneSnapshots(keeping count: Int, label: String) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: backupDirectory, includingPropertiesForKeys: nil) else { return }
        let snapshots = entries.filter { $0.lastPathComponent.hasSuffix(" " + label) }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
        for old in snapshots.dropFirst(count) { try? fm.removeItem(at: old) }
    }
}

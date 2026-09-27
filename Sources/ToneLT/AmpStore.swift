import Foundation
import LTKit
import Observation

@MainActor
@Observable
final class AmpStore {
    enum Status: Equatable {
        case searching
        case connecting
        case syncing(Int, Int)
        case connected
        case failed(String)
    }

    enum Section: Hashable {
        case amp, factory
    }

    var status: Status = .searching
    var info: AmpInfo?
    var presets: [Preset] = []
    var currentSlot: Int?
    var currentDirty = false
    let catalog = Catalog.load()

    var section: Section = .amp
    var selectedSlot: Int? = 1
    var selectedFactoryName: String?
    var autoAudition = false
    private(set) var auditioning = false

    /// Last notable event, shown in the status bar.
    var notice: String?
    var lastSnapshot: URL?

    private var client: AmpClient?
    private var searchTask: Task<Void, Never>?

    var isConnected: Bool { status == .connected }

    var selectedPreset: Preset? {
        switch section {
        case .amp:
            return presets.first { $0.slot == selectedSlot }
        case .factory:
            return catalog?.factoryPresets.first { $0.displayName == selectedFactoryName }
        }
    }

    var firstEmptySlot: Int? { presets.first(where: \.isEmptySlot)?.slot }

    // MARK: Connection

    func start() {
        guard searchTask == nil else { return }
        // Poll for the amp while disconnected; a failed attempt (e.g. another app has the
        // amp open) is retried, keeping its message on screen until it succeeds.
        searchTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if self.client == nil, self.status != .connecting {
                    if HIDTransport.attachedDevices().isEmpty {
                        self.status = .searching
                    } else {
                        await self.connect()
                    }
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func reconnect() {
        client?.disconnect()
        client = nil
        Task { await connect() }
    }

    private func connect() async {
        status = .connecting
        let client = AmpClient()
        client.onMessage = { [weak self] message in
            Task { @MainActor in self?.handle(message) }
        }
        client.onDisconnect = { [weak self] in
            Task { @MainActor in self?.lostConnection() }
        }
        do {
            let info = try await client.connect()
            self.client = client
            self.info = info
            let loaded = try await client.readAllPresets { done, total in
                Task { @MainActor [weak self] in self?.status = .syncing(done, total) }
            }
            try await client.finishSync()
            presets = loaded
            let current = try await client.currentPreset()
            currentSlot = current.slot
            currentDirty = current.dirty
            status = .connected
            if selectedSlot == nil { selectedSlot = current.slot }
            takeSnapshot()
        } catch {
            client.disconnect()
            self.client = nil
            status = .failed("\(error)")
        }
    }

    private func lostConnection() {
        client = nil
        info = nil
        auditioning = false
        status = .searching
        notice = "Amp disconnected."
    }

    private func takeSnapshot() {
        do {
            lastSnapshot = try Storage.snapshot(presets.filter { !$0.isEmptySlot }, label: "amp snapshot")
        } catch {
            notice = "Could not back up presets: \(error.localizedDescription)"
        }
    }

    private func handle(_ message: AmpMessage) {
        switch message {
        case .currentLoadedPresetIndex(let slot):
            currentSlot = slot
            currentDirty = false
            auditioning = false
        case .presetEdited(let edited):
            currentDirty = edited
        case .currentPreset(_, let slot, let dirty):
            currentSlot = slot
            currentDirty = dirty
        case .presetSaved(_, let slot), .newPresetSaved(_, let slot):
            // Something was stored on the amp (from its panel or from ltctl): re-read that slot.
            if isConnected { Task { await refreshSlot(slot) } }
        case .modalStatus(let context, _) where context == ModalContext.syncBegin.rawValue:
            break
        default:
            break
        }
    }

    // MARK: Reading

    func refreshAll() async {
        guard let client, isConnected else { return }
        do {
            presets = try await client.readAllPresets()
            let current = try await client.currentPreset()
            currentSlot = current.slot
            currentDirty = current.dirty
            notice = "Presets reloaded from the amp."
        } catch {
            notice = "Refresh failed: \(error)"
        }
    }

    private var refreshing = Set<Int>()

    func refreshSlot(_ slot: Int) async {
        guard let client, !refreshing.contains(slot) else { return }
        refreshing.insert(slot)
        defer { refreshing.remove(slot) }
        if let preset = try? await client.readPreset(slot: slot),
           let index = presets.firstIndex(where: { $0.slot == slot }) {
            presets[index] = preset
        }
    }

    // MARK: Amp actions

    func load(slot: Int) async {
        guard let client else { return }
        // While auditioning the amp reports the audition as an unsaved edit; leaving it is fine.
        if currentDirty && !auditioning {
            notice = "The amp's current preset has unsaved changes. Save or discard them on the amp first."
            return
        }
        do {
            try await client.loadPreset(slot: slot)
            currentSlot = slot
            auditioning = false
        } catch {
            notice = "Could not switch preset: \(error)"
        }
    }

    func audition(_ preset: Preset) async {
        guard let client, isConnected else { return }
        do {
            try await client.audition(json: preset.json)
            auditioning = true
            notice = "Auditioning “\(preset.displayName)”. Nothing is saved."
        } catch {
            notice = "Audition failed: \(error)"
        }
    }

    func exitAudition() async {
        guard let client, auditioning else { return }
        try? await client.exitAudition()
        auditioning = false
    }

    func factorySelectionChanged() {
        guard autoAudition, section == .factory, let preset = selectedPreset else { return }
        Task { await audition(preset) }
    }

    func sectionChanged() {
        if section == .amp, auditioning { Task { await exitAudition() } }
    }

    /// Stores `preset` in `slot`, backing up whatever was there first.
    func store(_ preset: Preset, in slot: Int) async throws {
        guard let client, isConnected else { throw TransportError.notOpen }
        if let existing = presets.first(where: { $0.slot == slot }), !existing.isEmptySlot {
            try Storage.backup(existing, reason: "before import to slot \(slot)")
        }
        let stored = try await client.writePreset(json: preset.json, slot: slot)
        if let index = presets.firstIndex(where: { $0.slot == slot }) {
            presets[index] = stored
        }
        section = .amp
        selectedSlot = slot
        notice = "Stored “\(stored.displayName)” in slot \(slot)."
    }

    // MARK: Files

    func export(_ preset: Preset, to url: URL) {
        do {
            try Storage.write(preset, to: url)
            notice = "Exported “\(preset.displayName)”."
        } catch {
            notice = "Export failed: \(error.localizedDescription)"
        }
    }

    func exportAll(to directory: URL) {
        do {
            let urls = try Storage.exportAll(presets.filter { !$0.isEmptySlot }, to: directory)
            notice = "Exported \(urls.count) presets."
        } catch {
            notice = "Export failed: \(error.localizedDescription)"
        }
    }

    func exportMarkdown(to url: URL) {
        guard let catalog else {
            notice = "The amp/effect catalog is missing from this build."
            return
        }
        let markdown = MarkdownExporter(catalog: catalog, ampPresets: presets, info: info).render()
        do {
            try markdown.write(to: url, atomically: true, encoding: .utf8)
            notice = "Wrote \(url.lastPathComponent)."
        } catch {
            notice = "Could not write Markdown: \(error.localizedDescription)"
        }
    }
}

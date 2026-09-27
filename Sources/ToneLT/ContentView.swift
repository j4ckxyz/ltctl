import AppKit
import LTKit
import SwiftUI

struct ContentView: View {
    @Environment(AmpStore.self) private var store
    @Binding var importRequest: ImportRequest?

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            Sidebar()
                .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 280)
        } content: {
            Group {
                switch store.section {
                case .amp: AmpPresetList(importRequest: $importRequest)
                case .factory: FactoryPresetList(importRequest: $importRequest)
                }
            }
            .navigationSplitViewColumnWidth(min: 240, ideal: 290, max: 360)
        } detail: {
            if let preset = store.selectedPreset {
                PresetDetail(preset: preset, importRequest: $importRequest)
            } else {
                ContentUnavailableView("No Preset Selected", systemImage: "slider.horizontal.3")
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { StatusBar() }
        .sheet(item: $importRequest) { request in
            ImportSheet(request: request)
        }
        .onChange(of: store.section) { store.sectionChanged() }
        .onChange(of: store.selectedFactoryName) { store.factorySelectionChanged() }
        .onChange(of: store.autoAudition) {
            if store.autoAudition {
                store.factorySelectionChanged()
            } else {
                Task { await store.exitAudition() }
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first(where: { ["preset", "json"].contains($0.pathExtension.lowercased()) }),
                  let preset = try? Storage.readPresetFile(url)
            else { return false }
            importRequest = ImportRequest(preset: preset, source: url.lastPathComponent)
            return true
        }
    }
}

struct ImportRequest: Identifiable {
    let id = UUID()
    var preset: Preset
    var source: String
    var suggestedSlot: Int?
}

// MARK: - Sidebar

private struct Sidebar: View {
    @Environment(AmpStore.self) private var store

    var body: some View {
        @Bindable var store = store
        List(selection: Binding(get: { store.section }, set: { if let s = $0 { store.section = s } })) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("My Amp Presets")
                    ConnectionLine()
                }
            } icon: {
                Image(systemName: "hifispeaker.fill")
            }
            .tag(AmpStore.Section.amp)
            .padding(.vertical, 3)

            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Factory Presets")
                    if store.catalog == nil {
                        Text("Catalog not bundled")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Toggle("Auto-Audition", isOn: $store.autoAudition)
                            .toggleStyle(.checkbox)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .disabled(!store.isConnected)
                            .help("Play the selected factory preset on the amp without saving it, like Fender Tone's Auto-Audition.")
                    }
                }
            } icon: {
                Image(systemName: "music.note.list")
            }
            .tag(AmpStore.Section.factory)
            .padding(.vertical, 3)
            .disabled(store.catalog == nil)
        }
    }
}

private struct ConnectionLine: View {
    @Environment(AmpStore.self) private var store

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text).lineLimit(1)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private var color: Color {
        switch store.status {
        case .connected: .green
        case .connecting, .syncing: .yellow
        case .searching: .gray
        case .failed: .red
        }
    }

    private var text: String {
        switch store.status {
        case .connected: store.info?.modelName ?? "Connected"
        case .connecting: "Connecting…"
        case .syncing(let done, let total): "Reading \(done)/\(total)…"
        case .searching: "No amp found"
        case .failed: "Can't connect"
        }
    }
}

// MARK: - Lists

private struct AmpPresetList: View {
    @Environment(AmpStore.self) private var store
    @Binding var importRequest: ImportRequest?

    var body: some View {
        @Bindable var store = store
        Group {
            if store.presets.isEmpty {
                placeholder
            } else {
                List(store.presets, selection: $store.selectedSlot) { preset in
                    PresetRow(preset: preset, isCurrent: preset.slot == store.currentSlot)
                        .tag(preset.slot)
                        .contextMenu { menu(for: preset) }
                }
            }
        }
        .navigationTitle("My Amp Presets")
        .toolbar {
            ToolbarItem {
                Button {
                    chooseFile()
                } label: {
                    Label("Import Preset", systemImage: "square.and.arrow.down")
                }
                .help("Import a .preset file into one of the amp's slots")
                .disabled(!store.isConnected)
            }
            ToolbarItem {
                Button {
                    Task { await store.refreshAll() }
                } label: {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
                .help("Read all presets from the amp again")
                .disabled(!store.isConnected)
            }
        }
    }

    @ViewBuilder
    private var placeholder: some View {
        switch store.status {
        case .failed(let message):
            ContentUnavailableView {
                Label("Can't Connect", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { store.reconnect() }
            }
        case .connecting, .syncing:
            ProgressView(progressText)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .searching, .connected:
            ContentUnavailableView(
                "Connect Your Amp",
                systemImage: "cable.connector",
                description: Text("Plug the Mustang LT into this Mac with a USB cable and turn it on.")
            )
        }
    }

    private var progressText: String {
        if case .syncing(let done, let total) = store.status { return "Reading presets \(done) of \(total)…" }
        return "Connecting…"
    }

    @ViewBuilder
    private func menu(for preset: Preset) -> some View {
        Button("Load on Amp") { Task { await store.load(slot: preset.slot ?? 1) } }
            .disabled(preset.isEmptySlot)
        Button("Export…") { exportPanel(preset) }
            .disabled(preset.isEmptySlot)
        Button("Import into This Slot…") { chooseFile(slot: preset.slot) }
    }

    private func chooseFile(slot: Int? = nil) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.presetFile, .json]
        panel.message = "Choose a preset to import into the amp"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            importRequest = ImportRequest(preset: try Storage.readPresetFile(url), source: url.lastPathComponent, suggestedSlot: slot)
        } catch {
            store.notice = "Could not read \(url.lastPathComponent): \(error)"
        }
    }

    private func exportPanel(_ preset: Preset) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.presetFile]
        panel.nameFieldStringValue = preset.fileBaseName + "." + Storage.presetExtension
        if panel.runModal() == .OK, let url = panel.url { store.export(preset, to: url) }
    }
}

private struct FactoryPresetList: View {
    @Environment(AmpStore.self) private var store
    @Binding var importRequest: ImportRequest?
    @State private var search = ""

    var body: some View {
        @Bindable var store = store
        let presets = (store.catalog?.factoryPresets ?? []).filter {
            search.isEmpty || $0.displayName.localizedCaseInsensitiveContains(search)
        }
        List(presets, selection: $store.selectedFactoryName) { preset in
            PresetRow(preset: preset, isCurrent: false)
                .tag(preset.displayName)
                .contextMenu {
                    Button("Audition on Amp") { Task { await store.audition(preset) } }
                        .disabled(!store.isConnected)
                    Button("Copy to My Amp…") {
                        importRequest = ImportRequest(preset: preset, source: "Factory Presets")
                    }
                    .disabled(!store.isConnected)
                }
        }
        .searchable(text: $search, placement: .sidebar)
        .navigationTitle("Factory Presets")
    }
}

struct PresetRow: View {
    let preset: Preset
    let isCurrent: Bool

    var body: some View {
        HStack(spacing: 10) {
            if let slot = preset.slot {
                Text(String(format: "%02d", slot))
                    .font(.system(.body, design: .monospaced).weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(preset.isEmptySlot ? "Empty" : preset.displayName)
                .foregroundStyle(preset.isEmptySlot ? .tertiary : .primary)
            Spacer()
            if isCurrent {
                Image(systemName: "speaker.wave.2.fill")
                    .foregroundStyle(.tint)
                    .help("Active on the amp")
            }
        }
        .padding(.vertical, 3)
    }
}

// MARK: - Status bar

private struct StatusBar: View {
    @Environment(AmpStore.self) private var store

    var body: some View {
        HStack(spacing: 12) {
            if let info = store.info {
                Text("\(info.modelName) · firmware \(info.firmware)")
            }
            if let notice = store.notice {
                Text(notice).lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            if store.lastSnapshot != nil {
                Button("Backups") {
                    NSWorkspace.shared.open(Storage.backupDirectory)
                }
                .buttonStyle(.link)
                .help("Every connect saves a copy of all presets here")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
    }
}

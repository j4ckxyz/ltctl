import AppKit
import LTKit
import SwiftUI
import UniformTypeIdentifiers

@main
struct ToneLTApp: App {
    @NSApplicationDelegateAdaptor private var appDelegate: AppDelegate
    @State private var store = AmpStore()
    @State private var importRequest: ImportRequest?

    var body: some Scene {
        Window("ToneLT", id: "main") {
            ContentView(importRequest: $importRequest)
                .environment(store)
                .frame(minWidth: 980, minHeight: 620)
                .task {
                    store.start()
                    appDelegate.openFile = { url in openPresetFile(url) }
                }
        }
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .newItem) {
                Button("Import Preset…") { chooseImportFile() }
                    .keyboardShortcut("o")
                Divider()
                Button("Export Preset…") { exportSelected() }
                    .keyboardShortcut("e")
                    .disabled(store.selectedPreset == nil)
                Button("Export All Presets…") { exportAll() }
                    .keyboardShortcut("e", modifiers: [.command, .shift])
                    .disabled(store.presets.isEmpty)
                Button("Export Agent Reference (Markdown)…") { exportMarkdown() }
                    .keyboardShortcut("m", modifiers: [.command, .shift])
                    .disabled(store.catalog == nil)
                Divider()
                Button("Show Backups in Finder") {
                    try? FileManager.default.createDirectory(at: Storage.backupDirectory, withIntermediateDirectories: true)
                    NSWorkspace.shared.open(Storage.backupDirectory)
                }
            }
            CommandMenu("Amp") {
                Button("Reload Presets from Amp") { Task { await store.refreshAll() } }
                    .keyboardShortcut("r")
                    .disabled(!store.isConnected)
                Button("Reconnect") { store.reconnect() }
                Divider()
                Button("Load Selected Preset on Amp") {
                    if let slot = store.selectedPreset?.slot { Task { await store.load(slot: slot) } }
                }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!store.isConnected || store.section != .amp)
            }
        }
    }

    private func openPresetFile(_ url: URL) {
        do {
            importRequest = ImportRequest(preset: try Storage.readPresetFile(url), source: url.lastPathComponent)
        } catch {
            store.notice = "Could not read \(url.lastPathComponent): \(error)"
        }
    }

    private func chooseImportFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.presetFile, .json]
        panel.allowsMultipleSelection = false
        panel.message = "Choose a preset to import into the amp"
        if panel.runModal() == .OK, let url = panel.url { openPresetFile(url) }
    }

    private func exportSelected() {
        guard let preset = store.selectedPreset else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.presetFile]
        panel.nameFieldStringValue = preset.fileBaseName + "." + Storage.presetExtension
        if panel.runModal() == .OK, let url = panel.url { store.export(preset, to: url) }
    }

    private func exportAll() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Export Here"
        panel.message = "Choose a folder for all \(store.presets.filter { !$0.isEmptySlot }.count) presets"
        if panel.runModal() == .OK, let url = panel.url { store.exportAll(to: url) }
    }

    private func exportMarkdown() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        panel.nameFieldStringValue = "\(store.info?.modelName ?? "Mustang LT") presets.md"
        if panel.runModal() == .OK, let url = panel.url { store.exportMarkdown(to: url) }
    }
}

extension UTType {
    static let presetFile = UTType(exportedAs: "local.tonelt.preset", conformingTo: .json)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var openFile: ((URL) -> Void)? {
        didSet {
            pending.forEach { openFile?($0) }
            pending.removeAll()
        }
    }
    private var pending: [URL] = []

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if let openFile { openFile(url) } else { pending.append(url) }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

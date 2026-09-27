import AppKit
import LTKit
import SwiftUI

struct PresetDetail: View {
    @Environment(AmpStore.self) private var store
    let preset: Preset
    @Binding var importRequest: ImportRequest?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView(.vertical) {
                if preset.isEmptySlot {
                    ContentUnavailableView(
                        "Empty Slot",
                        systemImage: "square.dashed",
                        description: Text("Import a preset file or copy a factory preset into this slot.")
                    )
                    .padding(60)
                } else {
                    SignalChain(preset: preset, catalog: store.catalog)
                        .padding(28)
                }
            }
        }
        .navigationTitle("")
    }

    private var header: some View {
        HStack(spacing: 14) {
            if let slot = preset.slot {
                Text(String(format: "%02d", slot))
                    .font(.title2.monospacedDigit().weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color.accentColor))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(preset.isEmptySlot ? "EMPTY" : preset.displayName.uppercased())
                    .font(.title2.weight(.semibold))
                if preset.slot != nil, preset.slot == store.currentSlot {
                    Text(store.auditioning ? "Stored on the amp (another preset is being auditioned)" :
                        store.currentDirty ? "Active on the amp · edited on the amp, not saved" : "Active on the amp")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            actions
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    @ViewBuilder
    private var actions: some View {
        if let slot = preset.slot {
            Button("Load on Amp") { Task { await store.load(slot: slot) } }
                .disabled(!store.isConnected || preset.isEmptySlot || slot == store.currentSlot && !store.auditioning)
            Menu {
                Button("Export…") { export() }
                    .disabled(preset.isEmptySlot)
                Button("Import into This Slot…") { chooseImport(slot: slot) }
                    .disabled(!store.isConnected)
                Divider()
                Button("Copy JSON") { copyJSON() }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuIndicator(.hidden)
            .fixedSize()
        } else {
            Button(store.auditioning ? "Stop Audition" : "Audition on Amp") {
                Task {
                    if store.auditioning { await store.exitAudition() } else { await store.audition(preset) }
                }
            }
            .disabled(!store.isConnected)
            Button("Copy to My Amp…") {
                importRequest = ImportRequest(preset: preset, source: "Factory Presets")
            }
            .disabled(!store.isConnected)
            Menu {
                Button("Export…") { export() }
                Button("Copy JSON") { copyJSON() }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuIndicator(.hidden)
            .fixedSize()
        }
    }

    private func export() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.presetFile]
        panel.nameFieldStringValue = preset.fileBaseName + "." + Storage.presetExtension
        if panel.runModal() == .OK, let url = panel.url { store.export(preset, to: url) }
    }

    private func copyJSON() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(preset.json, forType: .string)
        store.notice = "Copied “\(preset.displayName)” JSON."
    }

    private func chooseImport(slot: Int) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.presetFile, .json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            importRequest = ImportRequest(preset: try Storage.readPresetFile(url), source: url.lastPathComponent, suggestedSlot: slot)
        } catch {
            store.notice = "Could not read \(url.lastPathComponent): \(error)"
        }
    }
}

// MARK: - Signal chain

struct SignalChain: View {
    let preset: Preset
    let catalog: Catalog?

    var body: some View {
        // Left-to-right like Fender Tone when the window is wide enough; otherwise stack
        // the three sections top to bottom so nothing scrolls out of view.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 0) {
                section("PRE FX", [.stomp, .mod])
                connector
                section("AMP", [.amp])
                connector
                section("POST FX", [.delay, .reverb])
            }
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top, spacing: 0) {
                    section("PRE FX", [.stomp, .mod])
                    connector
                    section("AMP", [.amp])
                }
                section("POST FX", [.delay, .reverb])
            }
            VStack(alignment: .leading, spacing: 18) {
                section("PRE FX", [.stomp, .mod])
                section("AMP", [.amp])
                section("POST FX", [.delay, .reverb])
            }
        }
    }

    private func section(_ title: String, _ slots: [ChainSlot]) -> some View {
        VStack(spacing: 10) {
            Text(title)
                .font(.caption.weight(.bold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .overlay(RoundedRectangle(cornerRadius: 3).stroke(.secondary))
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(slots.enumerated()), id: \.offset) { index, slot in
                    if index > 0 { connector }
                    NodeCard(slot: slot, node: preset.node(slot), catalog: catalog)
                }
            }
        }
    }

    private var connector: some View {
        Rectangle()
            .fill(.tertiary)
            .frame(width: 14, height: 2)
            .padding(.top, 90)
    }
}

struct NodeCard: View {
    let slot: ChainSlot
    let node: PresetNode?
    let catalog: Catalog?

    private var unit: DSPUnitSpec? { node.flatMap { catalog?.unit($0.fenderId) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let node, !node.isEmpty {
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(catalog?.menuName(node.fenderId) ?? unit?.displayName ?? node.fenderId)
                            .font(.headline)
                        Text(slot.title.uppercased())
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if unit?.hasBypass ?? (slot != .amp) {
                        Circle()
                            .fill(node.isBypassed ? Color.secondary.opacity(0.4) : .red)
                            .frame(width: 9, height: 9)
                            .help(node.isBypassed ? "Effect off" : "Effect on")
                    }
                }
                knobs(node)
                details(node)
            } else {
                VStack(spacing: 6) {
                    Image(systemName: "plus")
                        .font(.title)
                    Text(slot.title.uppercased())
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, minHeight: 140)
            }
        }
        .padding(14)
        .frame(width: slot == .amp ? 260 : 168, alignment: .topLeading)
        .frame(minHeight: 170, alignment: .top)
        .background(RoundedRectangle(cornerRadius: 10).fill(.background.secondary))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator))
        .opacity(node?.isBypassed == true ? 0.6 : 1)
    }

    @ViewBuilder
    private func knobs(_ node: PresetNode) -> some View {
        let params = (unit?.params ?? []).filter { $0.onLTPanel && $0.kind == .continuous && node.params[$0.id] != nil }
        let columns = [GridItem(.adaptive(minimum: 52), spacing: 8)]
        if !params.isEmpty {
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(params, id: \.id) { p in
                    KnobView(spec: p, value: node.params[p.id]!)
                }
            }
        } else if unit == nil {
            // Unknown unit (catalog missing): show raw numbers.
            ForEach(node.params.keys.sorted(), id: \.self) { key in
                LabeledContent(key, value: node.params[key]!.description)
                    .font(.caption)
            }
        }
    }

    @ViewBuilder
    private func details(_ node: PresetNode) -> some View {
        let params = (unit?.params ?? []).filter {
            (!$0.onLTPanel || $0.kind != .continuous) && $0.id != "bypassType" && node.params[$0.id] != nil
        }
        if !params.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(params, id: \.id) { p in
                    HStack {
                        Text(p.displayName.capitalized)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(p.displayString(for: node.params[p.id]!))
                    }
                    .font(.caption)
                }
            }
            .padding(.top, 2)
        }
    }
}

struct KnobView: View {
    let spec: ParamSpec
    let value: ParamValue

    private var fraction: Double {
        guard case .number(let raw) = value, let min = spec.min, let max = spec.max, max != min else { return 0 }
        // Knob rotation is linear in the display value.
        var position = (raw - min) / (max - min)
        if let display = spec.displayValue(raw: raw), let dmin = spec.remap?.min, let dmax = spec.remap?.max, dmax != dmin {
            position = (display - dmin) / (dmax - dmin)
        }
        return Swift.min(Swift.max(position, 0), 1)
    }

    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                Circle()
                    .trim(from: 0.125, to: 0.875)
                    .stroke(.quaternary, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                    .rotationEffect(.degrees(90))
                Circle()
                    .trim(from: 0.125, to: 0.125 + 0.75 * fraction)
                    .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                    .rotationEffect(.degrees(90))
                Text(spec.displayString(for: value))
                    .font(.system(size: 11, weight: .semibold).monospacedDigit())
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .padding(.horizontal, 6)
            }
            .frame(width: 46, height: 46)
            Text(spec.displayName.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .help("\(spec.displayName): \(spec.displayString(for: value)) (stored as \(value.description))")
    }
}

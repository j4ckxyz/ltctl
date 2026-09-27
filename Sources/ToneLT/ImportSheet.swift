import LTKit
import SwiftUI

/// Confirms where an imported preset goes. Nothing is written until "Import" is pressed,
/// and a replaced slot is backed up first.
struct ImportSheet: View {
    @Environment(AmpStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let request: ImportRequest

    @State private var slot = 1
    @State private var working = false
    @State private var error: String?

    private var problems: [String] { request.preset.validate(catalog: store.catalog) }
    private var target: Preset? { store.presets.first { $0.slot == slot } }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Import “\(request.preset.displayName)”")
                    .font(.title2.weight(.semibold))
                Text("From \(request.source)")
                    .foregroundStyle(.secondary)
            }

            ChainSummary(preset: request.preset, catalog: store.catalog)

            if !problems.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Label("This preset can't be imported:", systemImage: "xmark.octagon.fill")
                        .foregroundStyle(.red)
                    ForEach(problems, id: \.self) { Text("• \($0)") }
                }
            } else {
                Picker("Store in slot", selection: $slot) {
                    ForEach(store.presets, id: \.slot) { preset in
                        Text(String(format: "%02d  %@", preset.slot ?? 0, preset.isEmptySlot ? "Empty" : preset.displayName))
                            .tag(preset.slot ?? 0)
                    }
                }
                .frame(maxWidth: 360)

                if let target, !target.isEmptySlot {
                    Label(
                        "This replaces “\(target.displayName)” in slot \(slot). A copy of it is saved to Backups first.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .foregroundStyle(.orange)
                } else {
                    Label("Slot \(slot) is empty.", systemImage: "checkmark.circle")
                        .foregroundStyle(.secondary)
                }
            }

            if let error {
                Text(error).foregroundStyle(.red)
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(target?.isEmptySlot == false ? "Replace" : "Import") { perform() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!problems.isEmpty || working || !store.isConnected)
            }
            if working { ProgressView().controlSize(.small) }
        }
        .padding(24)
        .frame(width: 560)
        .onAppear {
            slot = request.suggestedSlot ?? store.firstEmptySlot ?? 1
        }
    }

    private func perform() {
        working = true
        error = nil
        Task {
            do {
                try await store.store(request.preset, in: slot)
                dismiss()
            } catch {
                self.error = "\(error)"
            }
            working = false
        }
    }
}

/// One line per chain position: unit name and its panel settings.
struct ChainSummary: View {
    let preset: Preset
    let catalog: Catalog?

    var body: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 8) {
            ForEach(ChainSlot.allCases, id: \.self) { slot in
                GridRow {
                    Text(slot.title.uppercased())
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    if let node = preset.node(slot), !node.isEmpty {
                        let unit = catalog?.unit(node.fenderId)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(catalog?.menuName(node.fenderId) ?? unit?.displayName ?? node.fenderId)
                                .fontWeight(.medium)
                                + Text(node.isBypassed ? "  (off)" : "").foregroundStyle(.secondary)
                            Text(settings(node, unit))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Text("-").foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(.background.secondary))
    }

    private func settings(_ node: PresetNode, _ unit: DSPUnitSpec?) -> String {
        guard let unit else { return node.params.keys.sorted().map { "\($0) \(node.params[$0]!)" }.joined(separator: " · ") }
        return unit.params.filter(\.onLTPanel).compactMap { p in
            node.params[p.id].map { "\(p.displayName.capitalized) \(p.displayString(for: $0))" }
        }.joined(separator: " · ")
    }
}

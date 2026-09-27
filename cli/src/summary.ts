// A preset described in the amp's own terms (the `--json` shape of `ltctl show`), plus
// diffs and "tone spec" input.

import { type Catalog, formatNumber, type ParamValue, PASSTHRU, POSITIONS, type Position } from "./catalog";
import { EditError } from "./editor";
import type { Preset } from "./preset";

export interface ParamSummary {
  id: string;
  name: string;
  /** What the amp / Fender Tone shows: "6.5", "400 ms", "'65 Twin". */
  display: string;
  /** Numeric display value for continuous parameters (knob position etc.). */
  value: number | null;
  /** The value stored in the preset JSON. */
  raw: ParamValue;
  /** On the Mustang LT's panel (false: stored, advanced-only setting). */
  panel: boolean;
}

export interface NodeSummary {
  position: Position;
  /** FenderId, e.g. "DUBS_Ac30Tb"; "DUBS_Passthru" when empty. */
  unitId: string;
  /** Amp menu name, e.g. "60S UK CLN"; "none" when empty. */
  unit: string;
  empty: boolean;
  params: ParamSummary[];
}

export interface PresetSummary {
  slot: number | null;
  name: string;
  ampName: string;
  empty: boolean;
  chain: NodeSummary[];
}

export function summarize(preset: Preset, catalog: Catalog | undefined): PresetSummary {
  return {
    slot: preset.slot ?? null,
    name: preset.isEmptySlot ? "Empty" : preset.displayName,
    ampName: preset.rawName,
    empty: preset.isEmptySlot,
    chain: POSITIONS.map((position) => {
      const node = preset.node(position);
      if (!node) return { position, unitId: "", unit: "missing", empty: true, params: [] };
      const unit = catalog?.unit(node.fenderId);
      const params: ParamSummary[] = [];
      if (unit) {
        for (const spec of unit.params) {
          const raw = node.params[spec.id];
          if (spec.id === "bypassType" || raw === undefined) continue;
          const d = spec.kind === "continuous" && typeof raw === "number" ? spec.displayValue(raw) : undefined;
          params.push({ id: spec.id, name: spec.displayName, display: spec.display(raw), value: d === undefined ? null : Math.round(d * 1000) / 1000, raw, panel: spec.onPanel });
        }
      } else {
        for (const key of Object.keys(node.params).sort()) {
          if (key === "bypass" || key === "bypassType") continue;
          const raw = node.params[key]!;
          params.push({ id: key, name: key, display: String(raw), value: typeof raw === "number" ? raw : null, raw, panel: false });
        }
      }
      const empty = node.fenderId === PASSTHRU;
      return { position, unitId: node.fenderId, unit: empty ? "none" : catalog?.menuName(node.fenderId) ?? unit?.displayName ?? node.fenderId, empty, params };
    }),
  };
}

export function chainLine(s: PresetSummary): string {
  return s.chain.filter((n) => !n.empty).map((n) => n.unit).join(" → ");
}

export interface Change {
  key: string;
  from: string | null;
  to: string | null;
}

export function diff(a: PresetSummary, b: PresetSummary): Change[] {
  const changes: Change[] = [];
  if (a.ampName !== b.ampName) changes.push({ key: "name", from: a.name, to: b.name });
  for (const position of POSITIONS) {
    const x = a.chain.find((n) => n.position === position);
    const y = b.chain.find((n) => n.position === position);
    if (!x || !y) continue;
    if (x.unitId !== y.unitId) {
      changes.push({ key: position, from: x.unit, to: y.unit });
      continue;
    }
    const ids = [...new Set([...x.params.map((p) => p.id), ...y.params.map((p) => p.id)])];
    for (const id of ids) {
      const p = x.params.find((q) => q.id === id);
      const q = y.params.find((r) => r.id === id);
      // Compare what the amp shows: raw rounding below display precision isn't a change.
      if (p?.display !== q?.display) changes.push({ key: `${position}.${id}`, from: p?.display ?? null, to: q?.display ?? null });
    }
  }
  return changes;
}

/**
 * Turns a tone spec into assignments. Accepted shapes:
 *   {"name": "Spread Wings", "amp": {"unit": "ac30", "gain": 6, "treble": 5.8}, "delay": "none", "amp.bass": 5}
 * or `ltctl show --json` output (with a "chain" array), whose raw values are used as-is.
 */
export function specAssignments(text: string): string[] {
  let root: any;
  try {
    root = JSON.parse(text);
  } catch {
    throw new EditError("tone spec is not valid JSON");
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new EditError("tone spec must be a JSON object");
  const str = (v: unknown) => (v === null ? "none" : typeof v === "boolean" ? (v ? "on" : "off") : typeof v === "number" ? formatNumber(v) : String(v));
  const out: string[] = [];
  if (typeof root.name === "string") out.push(`name=${root.name}`);
  if (Array.isArray(root.chain)) {
    for (const node of root.chain) {
      if (!node?.position) continue;
      out.push(`${node.position}=${node.empty || node.unitId === PASSTHRU ? "none" : node.unitId ?? node.unit}`);
      for (const p of node.params ?? []) {
        // Raw values go through exactly (booleans as true/false, not on/off).
        if (p.raw !== undefined) out.push(`${node.position}.${p.id}=raw:${typeof p.raw === "boolean" ? String(p.raw) : str(p.raw)}`);
        else if (p.value !== undefined && p.value !== null) out.push(`${node.position}.${p.id}=${str(p.value)}`);
      }
    }
    return out;
  }
  // Positions first (choosing a unit resets its parameters), then flat keys.
  for (const position of POSITIONS) {
    if (!(position in root)) continue;
    const entry = root[position];
    if (entry && typeof entry === "object") {
      const unit = entry.unit ?? entry.model;
      if (unit !== undefined) out.push(`${position}=${str(unit)}`);
      for (const [k, v] of Object.entries(entry).sort()) if (k !== "unit" && k !== "model") out.push(`${position}.${k}=${str(v)}`);
    } else out.push(`${position}=${str(entry)}`);
  }
  for (const [k, v] of Object.entries(root).sort()) if (k.includes(".")) out.push(`${k}=${str(v)}`);
  return out;
}

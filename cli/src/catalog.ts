// The Mustang LT's amps and effects, extracted from Fender Tone LT Desktop into
// catalog.json by `ltctl setup` (src/extract.ts). Fender's data is never bundled.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Preset } from "./preset";
import { dataDir } from "./storage";

// ---------------------------------------------------------------- tapers

/** Fender's StandardTaper: tNN reaches NN% at half travel; i = inverse, r = reversed, s = S-curve. */
export type Taper =
  | { kind: "linear" }
  | { kind: "exp" | "log" | "sexp" | "slog"; k: number };

const TAPER_CONSTANTS: Record<string, [number, number]> = {
  t10: [81.0, 1013.98999],
  t15: [32.111, 94.7249985],
  t20: [16.0, 26.6100006],
  t25: [9.0, 11.4444999],
  t30: [5.4444499, 6.05614996],
  t35: [3.44899011, 3.59179997],
  t40: [2.25, 2.27540994],
  t45: [1.49382997, 1.49584997],
};

export function parseTaper(name?: string): Taper {
  if (!name || name === "t50") return { kind: "linear" };
  const constants = TAPER_CONSTANTS[name.slice(0, 3)];
  if (!constants) return { kind: "linear" };
  const [a, b] = constants;
  switch (name.slice(3)) {
    case "": return { kind: "exp", k: a };
    case "s": return { kind: "sexp", k: a };
    case "i": return { kind: "log", k: a };
    case "si": return { kind: "slog", k: a };
    case "r": return { kind: "log", k: b };
    case "rs": return { kind: "slog", k: b };
    case "ri": return { kind: "exp", k: b };
    case "rsi": return { kind: "sexp", k: b };
    default: return { kind: "linear" };
  }
}

const E = (k: number, x: number) => (Math.pow(k, x) - 1) / (k - 1);
const L = (k: number, x: number) => Math.log(x * (k - 1) + 1) / Math.log(k);

export function taperCalc(t: Taper, x: number): number {
  switch (t.kind) {
    case "linear": return x;
    case "exp": return E(t.k, x);
    case "log": return L(t.k, x);
    case "sexp": return x < 0.5 ? 0.5 * (1 - E(t.k, 1 - 2 * x)) : 0.5 * (E(t.k, 2 * x - 1) + 1);
    case "slog": return x < 0.5 ? 0.5 * (1 - L(t.k, 1 - 2 * x)) : 0.5 * (L(t.k, 2 * x - 1) + 1);
  }
}

export function taperInvert(t: Taper, y: number): number {
  switch (t.kind) {
    case "linear": return y;
    case "exp": return L(t.k, y);
    case "log": return E(t.k, y);
    case "sexp": return y < 0.5 ? (1 - L(t.k, 1 - 2 * y)) / 2 : (L(t.k, 2 * y - 1) + 1) / 2;
    case "slog": return y < 0.5 ? (1 - E(t.k, 1 - 2 * y)) / 2 : (E(t.k, 2 * y - 1) + 1) / 2;
  }
}

// ---------------------------------------------------------------- parameters

export type ParamValue = number | boolean | string;

export function formatNumber(d: number): string {
  if (Number.isInteger(d) && Math.abs(d) < 1e9) return String(d);
  return d.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** printf-style "%2.1f" / "%+3.1f" / "%0.0f" formatting for display values. */
function printf(format: string, v: number): string {
  const m = /%(\+)?(\d*)(?:\.(\d+))?f/.exec(format);
  if (!m) return v.toFixed(1);
  const digits = m[3] === undefined ? 6 : Number(m[3]);
  let s = v.toFixed(digits);
  if (s.startsWith("-") && Number(s) === 0) s = s.slice(1);
  if (m[1] && !s.startsWith("-")) s = "+" + s;
  return s;
}

export interface Remap {
  min?: number;
  max?: number;
  taper: Taper;
  taperName?: string;
  format?: string;
  /** undefined: no remap units; "": explicitly none. */
  units?: string;
  listItems: string[];
}

export class ParamSpec {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "continuous" | "list" | "listBool";
  readonly units?: string;
  readonly min?: number;
  readonly max?: number;
  readonly taperName?: string;
  readonly taper: Taper;
  readonly remap?: Remap;
  readonly listItems: string[];

  constructor(json: any, readonly onPanel: boolean) {
    this.id = json.controlId;
    this.displayName = String(json.paramGuiObjectNameMaximized ?? json.displayName ?? this.id).trim();
    this.kind = json.controlType === "list" || json.controlType === "listBool" ? json.controlType : "continuous";
    this.units = json.units || undefined;
    this.min = typeof json.min === "number" ? json.min : undefined;
    this.max = typeof json.max === "number" ? json.max : undefined;
    this.taperName = json.taper;
    this.taper = parseTaper(json.taper);
    this.listItems = json.listItems ?? [];
    if (json.remap) {
      this.remap = {
        min: typeof json.remap.min === "number" ? json.remap.min : undefined,
        max: typeof json.remap.max === "number" ? json.remap.max : undefined,
        taper: parseTaper(json.remap.taper),
        taperName: json.remap.taper,
        format: json.remap.format,
        units: json.remap.units,
        listItems: json.remap.listItems ?? [],
      };
    }
  }

  /** Units of the stored value (definitions sometimes put display units on the parameter). */
  get rawUnits(): string | undefined {
    return !this.remap || this.remap.units !== undefined ? this.units : undefined;
  }

  get displayUnits(): string | undefined {
    const u = this.remap?.units ?? this.units;
    return u ? u : undefined;
  }

  get hasDisplayRange(): boolean {
    return this.remap?.min !== undefined && this.remap?.max !== undefined;
  }

  /** display = dmin + (dmax − dmin) · remapTaper((raw − min) / (max − min)) */
  displayValue(raw: number): number | undefined {
    if (this.min === undefined || this.max === undefined || this.min === this.max) return undefined;
    const r = this.remap;
    if (!r || r.min === undefined || r.max === undefined) return raw;
    const fraction = Math.min(Math.max((raw - this.min) / (this.max - this.min), 0), 1);
    return r.min + (r.max - r.min) * taperCalc(r.taper, fraction);
  }

  rawValue(display: number): number | undefined {
    if (this.min === undefined || this.max === undefined) return undefined;
    const r = this.remap;
    if (!r || r.min === undefined || r.max === undefined || r.min === r.max) return display;
    const position = Math.min(Math.max((display - r.min) / (r.max - r.min), 0), 1);
    return this.min + (this.max - this.min) * taperInvert(r.taper, position);
  }

  /** How Fender Tone / the amp show a stored value. */
  display(value: ParamValue): string {
    if (this.kind === "list" && typeof value === "string") {
      const i = this.listItems.indexOf(value);
      return i >= 0 && this.remap?.listItems[i] ? this.remap.listItems[i]! : value;
    }
    if (this.kind === "listBool" && typeof value === "boolean") {
      const labels = this.remap?.listItems;
      return labels?.length === 2 ? labels[value ? 1 : 0]! : value ? "On" : "Off";
    }
    if (this.kind === "continuous" && typeof value === "number") {
      const d = this.displayValue(value);
      if (d === undefined) return formatNumber(value);
      const text = printf(this.remap?.format ?? "%.1f", d);
      return this.displayUnits ? `${text} ${this.displayUnits}` : text;
    }
    return typeof value === "string" ? value : String(value);
  }
}

export class DSPUnit {
  readonly fenderId: string;
  readonly displayName: string;
  readonly subcategory: string;
  readonly hasBypass: boolean;
  readonly tapParameter?: string;
  readonly defaults: Record<string, ParamValue>;
  readonly params: ParamSpec[];

  constructor(lt: any, advanced: any | undefined) {
    this.fenderId = lt.FenderId;
    this.displayName = lt.info?.displayName ?? this.fenderId;
    this.subcategory = lt.info?.subcategory ?? "";
    this.hasBypass = lt.ui?.hasBypass ?? false;
    this.tapParameter = lt.ui?.hasTap ? lt.ui?.tapParameter : undefined;
    this.defaults = lt.defaultDspUnitParameters ?? {};
    const params: ParamSpec[] = (lt.ui?.uiParameters ?? []).map((p: any) => new ParamSpec(p, true));
    const known = new Set(params.map((p) => p.id));
    for (const p of advanced?.ui?.uiParameters ?? []) if (!known.has(p.controlId)) params.push(new ParamSpec(p, false));
    this.params = params;
  }

  param(id: string): ParamSpec | undefined {
    return this.params.find((p) => p.id === id);
  }
}

export const POSITIONS = ["stomp", "mod", "amp", "delay", "reverb"] as const;
export type Position = (typeof POSITIONS)[number];
export const PASSTHRU = "DUBS_Passthru";

export class Catalog {
  readonly source: string;
  readonly units = new Map<string, DSPUnit>();
  /** Units selectable per position, in the amp's menu order, with the amp's menu labels. */
  readonly options = new Map<Position, { fenderId: string; menuName: string }[]>();
  readonly emptyPresetJSON: string;
  private readonly factoryRaw: any[];
  private factoryCache?: Preset[];

  constructor(root: any, readonly path: string) {
    this.source = root.source ?? "unknown";
    for (const [id, unit] of Object.entries<any>(root.dspUnits ?? {})) {
      this.units.set(id, new DSPUnit(unit, root.advancedDspUnits?.[id]));
    }
    const entries = (list: any[] | undefined) => (list ?? []).map((u) => ({ fenderId: u.FenderId, menuName: u.menuName18Max ?? u.FenderId }));
    for (const category of root.productProfile?.effectCategories ?? []) {
      if ((POSITIONS as readonly string[]).includes(category.categoryName)) this.options.set(category.categoryName, entries(category.dspUnits));
    }
    this.options.set("amp", entries(root.productProfile?.amp?.dspUnits));
    // Fender's EMPTY template lists the amp node first; the amp stores nodes in chain order.
    if (Array.isArray(root.emptyPreset?.audioGraph?.nodes)) {
      root.emptyPreset.audioGraph.nodes.sort((a: any, b: any) => POSITIONS.indexOf(a.nodeId) - POSITIONS.indexOf(b.nodeId));
    }
    this.emptyPresetJSON = root.emptyPreset ? JSON.stringify(root.emptyPreset) : "";
    this.factoryRaw = root.factoryPresets ?? [];
  }

  /** Fender's factory preset library, sorted by name (parsed on first use). */
  get factoryPresets(): Preset[] {
    this.factoryCache ??= this.factoryRaw
      .map((p) => Preset.parse(JSON.stringify(p), undefined))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return this.factoryCache;
  }

  unit(fenderId: string): DSPUnit | undefined {
    return this.units.get(fenderId);
  }

  menuName(fenderId: string): string | undefined {
    for (const list of this.options.values()) {
      const hit = list.find((o) => o.fenderId === fenderId);
      if (hit) return hit.menuName;
    }
    return undefined;
  }

  positionOf(fenderId: string): Position | undefined {
    for (const [position, list] of this.options) if (list.some((o) => o.fenderId === fenderId)) return position;
    return undefined;
  }

  // ------------------------------------------------------------ loading

  /** Where catalog.json is looked for, in order. */
  static candidatePaths(): string[] {
    const exeDir = dirname(process.execPath);
    return [
      process.env.TONELT_CATALOG,
      join(dataDir(), "catalog.json"),
      join(exeDir, "catalog.json"),
      join(exeDir, "../Resources/catalog.json"), // ltctl inside ToneLT.app
      "/Applications/ToneLT.app/Contents/Resources/catalog.json",
      join(import.meta.dir, "../../build/catalog.json"), // running from the repository
    ].filter((p): p is string => !!p);
  }

  static load(): Catalog | undefined {
    for (const path of Catalog.candidatePaths()) {
      if (!existsSync(path)) continue;
      try {
        return new Catalog(JSON.parse(readFileSync(path, "utf8")), path);
      } catch {
        continue;
      }
    }
    return undefined;
  }
}

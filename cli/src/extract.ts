// Builds catalog.json from the user's own copy of Fender Tone LT Desktop (macOS): the amp and
// effect definitions and the factory preset library are C strings in its executable, found
// through the Mach-O symbol table. Nothing is modified; a .dmg is attached read-only.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const APP_NAME = "Fender Tone LT Desktop.app";
const EXECUTABLE = "Contents/MacOS/Fender Tone LT Desktop";

export class ExtractError extends Error {}

interface Segment {
  vmaddr: bigint;
  filesize: bigint;
  fileoff: bigint;
}

/** Finds the x86_64 slice of a (possibly fat) Mach-O file. */
function machoSlice(data: Buffer): Buffer {
  const magic = data.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const wide = magic === 0xcafebabf;
    const count = data.readUInt32BE(4);
    for (let i = 0; i < count; i++) {
      const base = 8 + i * (wide ? 32 : 20);
      const cputype = data.readInt32BE(base);
      const offset = wide ? Number(data.readBigUInt64BE(base + 8)) : data.readUInt32BE(base + 8);
      const size = wide ? Number(data.readBigUInt64BE(base + 16)) : data.readUInt32BE(base + 12);
      if (cputype === 0x01000007) return data.subarray(offset, offset + size);
    }
    throw new ExtractError("the executable has no x86_64 slice");
  }
  if (data.readUInt32LE(0) !== 0xfeedfacf) throw new ExtractError("not a 64-bit Mach-O executable");
  return data;
}

/** Symbol name → address, for the symbols the catalog needs. */
function readSymbols(macho: Buffer): { segments: Segment[]; symbols: Map<string, bigint> } {
  const ncmds = macho.readUInt32LE(16);
  const segments: Segment[] = [];
  let symtab: { symoff: number; nsyms: number; stroff: number } | undefined;
  let offset = 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = macho.readUInt32LE(offset);
    const size = macho.readUInt32LE(offset + 4);
    if (cmd === 0x19) {
      segments.push({
        vmaddr: macho.readBigUInt64LE(offset + 24),
        fileoff: macho.readBigUInt64LE(offset + 40),
        filesize: macho.readBigUInt64LE(offset + 48),
      });
    } else if (cmd === 0x2) {
      symtab = { symoff: macho.readUInt32LE(offset + 8), nsyms: macho.readUInt32LE(offset + 12), stroff: macho.readUInt32LE(offset + 16) };
    }
    offset += size;
  }
  if (!symtab) throw new ExtractError("the executable has no symbol table");
  const symbols = new Map<string, bigint>();
  const wanted = /^__ZN4fmic(?:4dubs2(?:lt7mustang|gt)|7presets2lt7mustang|2pp2lt)/;
  for (let i = 0; i < symtab.nsyms; i++) {
    const entry = symtab.symoff + i * 16;
    const strx = macho.readUInt32LE(entry);
    const start = symtab.stroff + strx;
    // Cheap prefix test before decoding the whole name.
    if (macho[start + 1] !== 0x5f || macho[start + 2] !== 0x5a || macho[start + 3] !== 0x4e) continue;
    const end = macho.indexOf(0, start);
    const name = macho.toString("latin1", start, end);
    if (!wanted.test(name)) continue;
    const decoded = demangle(name);
    if (decoded) symbols.set(decoded, macho.readBigUInt64LE(entry + 8));
  }
  return { segments, symbols };
}

/** "__ZN4fmic4dubs2lt7mustang17DUBS_Twin65DefaultE" → "fmic::dubs::lt::mustang::DUBS_Twin65Default" */
export function demangle(name: string): string | undefined {
  let i = name.indexOf("ZN");
  if (i < 0) return undefined;
  i += 2;
  const parts: string[] = [];
  while (i < name.length && name[i] !== "E") {
    if (name[i] === "L") i++; // internal linkage marker
    const m = /^\d+/.exec(name.slice(i));
    if (!m) return undefined;
    const length = Number(m[0]);
    i += m[0].length;
    parts.push(name.slice(i, i + length));
    i += length;
  }
  return name[i] === "E" ? parts.join("::") : undefined;
}

function cstringAt(macho: Buffer, segments: Segment[], address: bigint): string {
  for (const s of segments) {
    if (address >= s.vmaddr && address < s.vmaddr + s.filesize) {
      const start = Number(s.fileoff + address - s.vmaddr);
      return macho.toString("utf8", start, macho.indexOf(0, start));
    }
  }
  throw new ExtractError(`address 0x${address.toString(16)} is outside the executable`);
}

function appVersion(app: string): string {
  const plist = join(app, "Contents/Info.plist");
  const json = spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" });
  if (json.status === 0) return JSON.parse(json.stdout).CFBundleShortVersionString ?? "?";
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, "utf8"));
  return m?.[1] ?? "?";
}

function findApp(root: string): string | undefined {
  if (existsSync(join(root, APP_NAME))) return join(root, APP_NAME);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.endsWith(".app") && !entry.name.startsWith(".")) {
      const found = findApp(join(root, entry.name));
      if (found) return found;
    }
  }
  return undefined;
}

/** Where Fender Tone LT Desktop usually is, for `ltctl setup` with no argument. */
export function findFenderApp(): string | undefined {
  const home = process.env.HOME ?? "";
  const candidates = [join("/Applications", APP_NAME), join(home, "Applications", APP_NAME)];
  for (const dir of [join(home, "Downloads"), join(home, "Desktop")]) {
    try {
      for (const name of readdirSync(dir)) if (/^Fender.*Tone.*\.dmg$/i.test(name)) candidates.push(join(dir, name));
    } catch {
      // folder missing
    }
  }
  return candidates.find((c) => existsSync(c));
}

/** Extracts the catalog from Fender Tone LT Desktop (.app, its executable, or the installer .dmg). */
export function extractCatalog(source: string): any {
  let mountpoint: string | undefined;
  try {
    let app: string;
    if (source.toLowerCase().endsWith(".dmg")) {
      if (process.platform !== "darwin") throw new ExtractError("reading a .dmg needs macOS; use the installed app, or run setup on a Mac and copy catalog.json");
      mountpoint = mkdtempSync(join(tmpdir(), "ltctl-dmg-"));
      const attach = spawnSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-noverify", "-noautoopen", "-mountpoint", mountpoint, source], { encoding: "utf8" });
      if (attach.status !== 0) throw new ExtractError(`could not open ${basename(source)}: ${attach.stderr.trim()}`);
      const found = findApp(mountpoint);
      if (!found) throw new ExtractError(`${APP_NAME} is not in ${basename(source)}`);
      app = found;
    } else if (source.endsWith(".app")) {
      app = source;
    } else {
      app = source.replace(/\/Contents\/MacOS\/[^/]+$/, "");
    }
    const executable = source.endsWith(".app") || source.toLowerCase().endsWith(".dmg") ? join(app, EXECUTABLE) : source;
    if (!existsSync(executable)) throw new ExtractError(`${executable} not found`);
    const macho = machoSlice(readFileSync(executable));
    const { segments, symbols } = readSymbols(macho);
    const json = (name: string) => {
      const address = symbols.get(name);
      if (address === undefined) throw new ExtractError(`${name} not found; is this Fender Tone LT Desktop?`);
      return JSON.parse(cstringAt(macho, segments, address));
    };

    const lt = "fmic::dubs::lt::mustang::";
    const units: Record<string, any> = {};
    const advanced: Record<string, any> = {};
    for (const name of [...symbols.keys()].sort()) {
      if (!name.startsWith(lt) || !name.endsWith("Default")) continue;
      const unit = json(name);
      if (unit?.nodeType !== "dspUnit") continue;
      units[unit.FenderId] = unit;
      const gt = `fmic::dubs::gt::${unit.FenderId}Default`;
      if (symbols.has(gt)) advanced[unit.FenderId] = json(gt);
    }
    const presetPrefix = "fmic::presets::lt::mustang::";
    const factoryPresets = [...symbols.keys()]
      .filter((n) => n.startsWith(presetPrefix) && n !== `${presetPrefix}EmptyPreset`)
      .sort()
      .flatMap((n) => {
        try {
          const p = json(n);
          return p?.nodeType === "preset" ? [p] : [];
        } catch {
          return [];
        }
      });
    if (!Object.keys(units).length) throw new ExtractError("no Mustang LT definitions found; is this Fender Tone LT Desktop?");
    return {
      source: `Fender Tone LT Desktop ${appVersion(app)}`,
      productProfile: json("fmic::pp::lt::PP_MustangLT"),
      dspUnits: units,
      advancedDspUnits: advanced,
      emptyPreset: json(`${presetPrefix}EmptyPreset`),
      factoryPresets,
    };
  } finally {
    if (mountpoint) {
      spawnSync("hdiutil", ["detach", "-quiet", mountpoint]);
      rmSync(mountpoint, { recursive: true, force: true });
    }
  }
}

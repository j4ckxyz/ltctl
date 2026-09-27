// Files, backups and the slot cache. On macOS these are the same locations ToneLT.app
// uses, so the app and the CLI share backups and cache.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Preset } from "./preset";

const home = homedir();

/** ~/Library/Application Support/ToneLT, ~/.local/share/tonelt, or %APPDATA%\ToneLT */
export function dataDir(): string {
  if (process.env.TONELT_HOME) return process.env.TONELT_HOME;
  switch (process.platform) {
    case "darwin": return join(home, "Library/Application Support/ToneLT");
    case "win32": return join(process.env.APPDATA ?? join(home, "AppData/Roaming"), "ToneLT");
    default: return join(process.env.XDG_DATA_HOME ?? join(home, ".local/share"), "tonelt");
  }
}

export function cacheDir(): string {
  if (process.env.TONELT_HOME) return join(process.env.TONELT_HOME, "cache");
  switch (process.platform) {
    case "darwin": return join(home, "Library/Caches/ToneLT");
    case "win32": return join(process.env.LOCALAPPDATA ?? join(home, "AppData/Local"), "ToneLT", "Cache");
    default: return join(process.env.XDG_CACHE_HOME ?? join(home, ".cache"), "tonelt");
  }
}

export function backupDir(): string {
  return join(dataDir(), "Backups");
}

export const PRESET_EXTENSION = "preset";

/** Writes via a temporary file so a crash never leaves half a file; devices such as
 * /dev/stdout or /dev/null are written directly. */
export function writeAtomic(path: string, contents: string): void {
  if (existsSync(path) && !statSync(path).isFile()) {
    writeFileSync(path, contents);
    return;
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export function readPresetFile(path: string): Preset {
  return Preset.parse(readFileSync(path, "utf8").trim(), undefined);
}

export function writePresetFile(preset: Preset, path: string): void {
  writeAtomic(path, preset.json);
}

function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Writes presets as "NN Name.preset" into a folder; returns the paths. */
export function exportAll(presets: Preset[], dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  return presets.map((p) => {
    const path = join(dir, `${p.fileBaseName}.${PRESET_EXTENSION}`);
    writePresetFile(p, path);
    return path;
  });
}

/** Saves a slot's current contents before it is overwritten. */
export function backup(preset: Preset, reason: string): string {
  const dir = join(backupDir(), `${stamp()} ${reason}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${preset.fileBaseName}.${PRESET_EXTENSION}`);
  writePresetFile(preset, path);
  return path;
}

/** Snapshot of many slots; keeps the newest 20 per label. */
export function snapshot(presets: Preset[], label: string): string {
  const dir = join(backupDir(), `${stamp()} ${label}`);
  exportAll(presets, dir);
  const old = readdirSync(backupDir())
    .filter((name) => name.endsWith(` ${label}`))
    .sort()
    .reverse()
    .slice(20);
  for (const name of old) rmSync(join(backupDir(), name), { recursive: true, force: true });
  return dir;
}

// ---------------------------------------------------------------- cache

interface CacheFile {
  productId: string;
  /** readAt: seconds since 1970 (the Swift app's JSONEncoder format). */
  slots: Record<string, { json: string; readAt: number }>;
}

/** Last-known contents of each slot, refreshed on every read/write by ltctl and ToneLT.app. */
export const PresetCache = {
  path(): string {
    return join(cacheDir(), "presets.json");
  },

  read(): CacheFile | undefined {
    try {
      return JSON.parse(readFileSync(this.path(), "utf8"));
    } catch {
      return undefined;
    }
  },

  store(presets: Preset[], productId: string): void {
    try {
      let file = this.read();
      if (!file || file.productId !== productId) file = { productId, slots: {} };
      const now = Date.now() / 1000;
      for (const p of presets) if (p.slot !== undefined) file.slots[String(p.slot)] = { json: p.json, readAt: now };
      mkdirSync(cacheDir(), { recursive: true });
      writeAtomic(this.path(), JSON.stringify(file));
    } catch {
      // The cache is an optimisation; never fail a command over it.
    }
  },

  load(): { productId: string; presets: Map<number, { preset: Preset; readAt: Date }> } {
    const file = this.read();
    const presets = new Map<number, { preset: Preset; readAt: Date }>();
    for (const [key, entry] of Object.entries(file?.slots ?? {})) {
      try {
        presets.set(Number(key), { preset: Preset.parse(entry.json, Number(key)), readAt: new Date(entry.readAt * 1000) });
      } catch {
        // skip corrupt entries
      }
    }
    return { productId: file?.productId ?? "", presets };
  },
};

export function exists(path: string): boolean {
  return existsSync(path);
}

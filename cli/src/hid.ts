// USB HID access through node-hid's prebuilt Node-API addon (hidapi inside), loaded
// directly so `bun build --compile` embeds the right binary for each platform.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_SIZE } from "./protocol";
import { cacheDir } from "./storage";

export const FENDER_VENDOR_ID = 0x1ed8;
/** Run-mode product IDs accepted by Fender Tone LT Desktop (LTMessageManager::enumerateDevices). */
export const LT_PRODUCT_IDS = [0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x45, 0x46];
const VENDOR_USAGE_PAGE = 0xff00;

interface NativeDevice {
  path?: string;
  vendorId: number;
  productId: number;
  product?: string;
  usagePage?: number;
  interface?: number;
}

interface NativeHandle {
  readStart(callback: (error: unknown, data: Uint8Array) => void): void;
  readStop(): void;
  write(data: Uint8Array | number[]): Promise<number>;
  close(): Promise<void>;
}

interface Binding {
  devicesAsync(vid: number, pid: number): Promise<NativeDevice[]>;
  openAsyncHIDDevice(path: string, options: { nonExclusive: boolean }): Promise<NativeHandle>;
}

// Each platform's HID addon. From source these are paths in node_modules; in a compiled
// executable (scripts/build.ts swaps in addons.embedded.ts) they point into Bun's virtual
// filesystem, and loading from there costs ~45 ms per run because the addon is re-extracted
// and re-verified every time. So it is copied to the cache folder once and loaded from disk.
import { ADDONS } from "./addons";

let binding: Binding | undefined;

function loadBinding(): Binding {
  if (binding) return binding;
  const platform = `${process.platform}-${process.arch}`;
  const embedded = ADDONS[platform];
  if (!embedded) throw new HidError("unsupported_platform", `USB access is not available for ${platform}.`);
  let path = embedded;
  // Embedded paths look like /$bunfs/root/… (B:\\~BUN\\root\\… on Windows).
  if (embedded.includes("$bunfs") || embedded.includes("~BUN")) {
    const bytes = readFileSync(embedded);
    path = join(cacheDir(), `hid-${platform}-${Bun.hash(bytes).toString(16)}.node`);
    if (!existsSync(path)) {
      mkdirSync(cacheDir(), { recursive: true });
      const tmp = `${path}.${process.pid}`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    }
  }
  binding = require(path) as Binding;
  return binding;
}

export class HidError extends Error {
  constructor(readonly code: "not_found" | "busy" | "io" | "unsupported_platform" | "permission", message: string) {
    super(message);
  }
}

export interface AttachedAmp {
  path: string;
  productId: number;
  name: string;
}

/** LT amps currently on USB (vendor-defined interface only). */
export async function findAmps(): Promise<AttachedAmp[]> {
  const hid = loadBinding();
  const found: AttachedAmp[] = [];
  const all = await hid.devicesAsync(FENDER_VENDOR_ID, 0);
  for (const d of all) {
    if (!d.path || !LT_PRODUCT_IDS.includes(d.productId)) continue;
    // macOS/Windows report the usage page; Linux hidraw may not, so fall back to interface 0.
    if (d.usagePage !== undefined && d.usagePage !== 0 && d.usagePage !== VENDOR_USAGE_PAGE) continue;
    if (found.some((f) => f.path === d.path)) continue;
    found.push({ path: d.path, productId: d.productId, name: d.product ?? "Fender LT" });
  }
  return found;
}

/** Raw 64-byte report channel to the amp. */
export class HidTransport {
  onReport?: (report: Uint8Array) => void;
  onError?: (error: unknown) => void;

  private constructor(private handle: NativeHandle, readonly amp: AttachedAmp) {}

  static async open(): Promise<HidTransport> {
    const amps = await findAmps();
    const amp = amps[0];
    if (!amp) throw new HidError("not_found", "No Mustang LT amp is connected over USB.");
    let handle: NativeHandle;
    try {
      handle = await loadBinding().openAsyncHIDDevice(amp.path, { nonExclusive: true });
    } catch (error) {
      const text = String(error);
      if (/exclusive|busy|in use/i.test(text)) throw new HidError("busy", "Another program is using the amp.");
      if (/permission|access/i.test(text)) throw new HidError("permission", `No permission to open the amp (${text}).`);
      throw new HidError("io", `Could not open the amp: ${text}`);
    }
    const transport = new HidTransport(handle, amp);
    handle.readStart((error, data) => {
      if (error) transport.onError?.(error);
      else transport.onReport?.(data);
    });
    return transport;
  }

  /** Writes one output report (the interface has no report IDs, so byte 0 is 0x00). */
  async write(report: Uint8Array): Promise<void> {
    const out = new Uint8Array(REPORT_SIZE + 1);
    out.set(report.subarray(0, REPORT_SIZE), 1);
    try {
      await this.handle.write(out);
    } catch (error) {
      throw new HidError("io", `USB write failed: ${error}`);
    }
  }

  /**
   * Stops reading and closes the device. `release: false` skips waiting for hidapi's reader
   * thread (~30–50 ms); only for a process that exits immediately, which releases the device.
   */
  async close(release = true): Promise<void> {
    try {
      this.handle.readStop();
      if (release) await this.handle.close();
    } catch {
      // Already closed or unplugged.
    }
  }
}

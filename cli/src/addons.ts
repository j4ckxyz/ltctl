// HID addon paths when running from source (see addons.embedded.ts for compiled builds).
import { join } from "node:path";

const prebuilds = join(import.meta.dir, "../node_modules/node-hid/prebuilds");

export const ADDONS: Record<string, string> = {
  "darwin-arm64": join(prebuilds, "HID-darwin-arm64/node-napi-v4.node"),
  "darwin-x64": join(prebuilds, "HID-darwin-x64/node-napi-v4.node"),
  "win32-x64": join(prebuilds, "HID-win32-x64/node-napi-v4.node"),
  "win32-arm64": join(prebuilds, "HID-win32-arm64/node-napi-v4.node"),
  // Linux uses the hidraw backend, which works without detaching kernel drivers.
  "linux-x64": join(prebuilds, "HID_hidraw-linux-x64/node-napi-v4.node"),
  "linux-arm64": join(prebuilds, "HID_hidraw-linux-arm64/node-napi-v4.node"),
};

// HID addons embedded into compiled executables; scripts/build.ts substitutes this module
// for addons.ts. (Bun's runtime can't import .node files as "file", only the bundler can.)
import darwinArm64 from "../node_modules/node-hid/prebuilds/HID-darwin-arm64/node-napi-v4.node" with { type: "file" };
import darwinX64 from "../node_modules/node-hid/prebuilds/HID-darwin-x64/node-napi-v4.node" with { type: "file" };
import win32X64 from "../node_modules/node-hid/prebuilds/HID-win32-x64/node-napi-v4.node" with { type: "file" };
import win32Arm64 from "../node_modules/node-hid/prebuilds/HID-win32-arm64/node-napi-v4.node" with { type: "file" };
import linuxX64 from "../node_modules/node-hid/prebuilds/HID_hidraw-linux-x64/node-napi-v4.node" with { type: "file" };
import linuxArm64 from "../node_modules/node-hid/prebuilds/HID_hidraw-linux-arm64/node-napi-v4.node" with { type: "file" };

export const ADDONS: Record<string, string> = {
  "darwin-arm64": darwinArm64,
  "darwin-x64": darwinX64,
  "win32-x64": win32X64,
  "win32-arm64": win32Arm64,
  "linux-x64": linuxX64,
  "linux-arm64": linuxArm64,
};

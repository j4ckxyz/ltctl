// Packages dist/ltctl-* into release archives with checksums:
//   release/ltctl-<os>-<arch>.tar.gz (macOS, Linux) and .zip (Windows), plus SHA256SUMS.
// Run after `bun run build`. macOS binaries are re-signed ad hoc (needs macOS).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const repo = join(root, "..");
const dist = join(root, "dist");
const release = join(root, "release");
rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });

function run(cmd: string, args: string[], cwd?: string) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

const binaries = readdirSync(dist).filter((f) => f.startsWith("ltctl-"));
if (!binaries.length) throw new Error("dist/ is empty: run `bun run build` first");

const sums: string[] = [];
for (const file of binaries.sort()) {
  const windows = file.endsWith(".exe");
  const name = file.replace(/\.exe$/, "");
  const stage = join(release, name);
  mkdirSync(stage);
  const exe = join(stage, windows ? "ltctl.exe" : "ltctl");
  copyFileSync(join(dist, file), exe);
  if (file.startsWith("ltctl-macos-")) {
    if (process.platform === "darwin") {
      // Bun's own signature doesn't cover the appended program; an ad-hoc signature without
      // the hardened runtime also lets the cached USB addon load.
      run("codesign", ["--force", "--sign", "-", "--identifier", "ltctl", exe]);
    } else {
      console.warn(`warning: ${file} not re-signed (needs macOS)`);
    }
  }
  for (const doc of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    if (existsSync(join(repo, doc))) copyFileSync(join(repo, doc), join(stage, doc));
  }
  const archive = windows ? `${name}.zip` : `${name}.tar.gz`;
  if (windows) run("zip", ["-q", "-9", "-j", join(release, archive), ...readdirSync(stage).map((f) => join(stage, f))]);
  else run("tar", ["-czf", join(release, archive), "-C", stage, ...readdirSync(stage)]);
  rmSync(stage, { recursive: true });
  const hash = new Bun.CryptoHasher("sha256").update(readFileSync(join(release, archive))).digest("hex");
  sums.push(`${hash}  ${archive}`);
  console.log(`✓ release/${archive}`);
}
writeFileSync(join(release, "SHA256SUMS"), sums.join("\n") + "\n");
console.log("✓ release/SHA256SUMS");

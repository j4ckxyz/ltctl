// Builds standalone ltctl executables (no Bun or Node needed to run them).
//   bun run build            → every platform into dist/
//   bun run build --host     → just this machine
import { mkdirSync } from "node:fs";

const targets = [
  { target: "bun-darwin-arm64", out: "ltctl-macos-arm64" },
  { target: "bun-darwin-x64-baseline", out: "ltctl-macos-x64" },
  { target: "bun-linux-x64-baseline", out: "ltctl-linux-x64" },
  { target: "bun-linux-arm64", out: "ltctl-linux-arm64" },
  { target: "bun-windows-x64-baseline", out: "ltctl-windows-x64.exe" },
  { target: "bun-windows-arm64", out: "ltctl-windows-arm64.exe" },
] as const;

const host = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const selected = process.argv.includes("--host") ? targets.filter((t) => t.target === host) : targets;
mkdirSync("dist", { recursive: true });

for (const { target, out } of selected) {
  const result = await Bun.build({
    entrypoints: ["src/main.ts"],
    minify: true,
    bytecode: true,
    compile: { target: target as any, outfile: `dist/${out}` },
    plugins: [
      {
        name: "embed-hid-addons",
        setup(build) {
          build.onResolve({ filter: /^\.\/addons$/ }, (args) => ({ path: `${args.resolveDir}/addons.embedded.ts` }));
        },
      },
    ],
  });
  if (!result.success) {
    console.error(`✗ ${target}`, result.logs);
    process.exit(1);
  }
  const size = (Bun.file(`dist/${out}`).size / 1e6).toFixed(1);
  console.log(`✓ dist/${out} (${size} MB)`);
}

# ltctl source

The ltctl command-line tool. For installing and using it, see the
[main README](../README.md); for every command, [docs/COMMANDS.md](../docs/COMMANDS.md).

```sh
bun install
bun src/main.ts --help        # run from source
bun test                      # tests (no amp needed)
bunx tsc -p .                 # type-check
bun run build                 # dist/ltctl-<os>-<arch> for every platform
bun run build --host          # just this machine
bun run package               # release/ archives and SHA256SUMS (after build)
bun run docs                  # regenerate ../docs/COMMANDS.md
```

| File | Purpose |
|---|---|
| `src/main.ts` | Entry point: argument parsing and dispatch |
| `src/help.ts` | Help text, `ltctl guide`, completions, `ltctl commands --json` |
| `src/commands.ts` | Every command, described once (help and docs are generated from it) |
| `src/cli.ts` | Output modes, errors and exit codes, preset references, amp sessions |
| `src/amp.ts` | The amp session: handshake, requests, reads, writes, audition |
| `src/protocol.ts` | Protobuf encoding, message types and 64-byte HID framing |
| `src/hid.ts`, `src/addons*.ts` | USB HID through node-hid's prebuilt addon |
| `src/preset.ts` | Preset JSON, names and validation |
| `src/catalog.ts` | Units, parameters and tapers from catalog.json |
| `src/editor.ts` | `key=value` assignments in display units |
| `src/summary.ts` | Preset descriptions, diffs and JSON tone specs |
| `src/storage.ts` | Files, backups and the slot cache |
| `src/extract.ts` | Reads the catalogue out of Fender Tone LT Desktop |
| `src/markdown.ts` | The agent reference (`ltctl markdown`) |

The protocol is documented in [docs/PROTOCOL.md](../docs/PROTOCOL.md).

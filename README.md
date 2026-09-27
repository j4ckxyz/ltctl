# ltctl

**Control a Fender Mustang LT amp from the command line.** Read every preset on the amp, back
them up, design new sounds in the amp's own terms, and store them, all over the USB cable. Works
on macOS, Linux and Windows, and is built to be driven by scripts and AI agents as well as by
people.

```console
$ ltctl list
 01  Fender Clean       COMPRESSOR → TWIN CLEAN → SPRING 65
 02  Silky Solo         OVERDRIVE → BURN → ECHO → SPRING 65
 ...
$ ltctl new "Spread Wings" amp=ac30 amp.gain=6 amp.cab="2x12 blue" stomp="5 band eq" stomp.gain=9 \
    reverb="small room" reverb.level=2.5 -o wings.preset
$ ltctl push wings.preset --slot empty
Stored "Spread Wings" in slot 49.
```

ltctl is unofficial and not affiliated with Fender. It exists because Fender Tone LT Desktop, the
official app, only runs on Intel Macs and Windows, and will stop working on macOS once Rosetta
is retired.

## Contents

- [Features](#features)
- [Install](#install)
- [First run](#first-run)
- [Quick start](#quick-start)
- [Creating and editing presets](#creating-and-editing-presets)
- [Using ltctl from scripts and agents](#using-ltctl-from-scripts-and-agents)
- [Safety](#safety)
- [How it works](#how-it-works)
- [How it was made](#how-it-was-made)
- [Troubleshooting](#troubleshooting)
- [Building from source](#building-from-source)
- [The Mac app](#the-mac-app)
- [Licence and trademarks](#licence-and-trademarks)

## Features

- **Read everything:** list all 60 slots, show any preset with its knob values exactly as the
  amp displays them (including the settings the amp hides, such as cabinet, noise gate, sag and
  bias), and compare presets.
- **Back up and restore:** pull every preset into `.preset` files (the same format as Fender
  Tone's Export Preset), snapshot the amp, and write a folder back.
- **Create and edit presets without touching raw numbers:** `amp.gain=6.5`,
  `delay.time=400ms`, `amp.cab="2x12 blue"`. ltctl converts to the stored values using Fender's
  own parameter curves, and checks everything before it reaches the amp.
- **Try before you store:** audition a preset on the amp without saving it.
- **Fender's factory library:** all 100 factory presets, usable as starting points.
- **Agent-friendly:** `--json` everywhere, meaningful exit codes, no prompts, `--dry-run`, and
  self-describing commands. `ltctl markdown` writes a complete reference an AI can use to
  design tones for your amp.
- **Safe by default:** it never overwrites a preset without being told to, backs up anything it
  replaces and reads every write back to verify it.
- **Fast:** about 90 ms for a command that talks to the amp, and 30 ms for one that doesn't.

Tested with a Mustang LT25 (firmware 2.1.4). The LT40S and LT50 use the same protocol and
product family, so they should work; reports are welcome.

## Install

### macOS and Linux

```sh
curl -fsSL https://raw.githubusercontent.com/j4ckxyz/ltctl/main/install.sh | sh
```

This installs `ltctl` for all users in `/usr/local/bin` (asking for your password if that folder
needs it), after checking the download against the release's SHA-256 checksums. On Linux it
also adds a udev rule so you can use the amp without `sudo`.

Options go before `sh`, for example
`curl -fsSL … | LTCTL_INSTALL_DIR=~/.local/bin sh`:

| Variable | Effect |
|---|---|
| `LTCTL_VERSION=v1.0.0` | Install a particular release instead of the latest |
| `LTCTL_INSTALL_DIR=~/.local/bin` | Install somewhere else (no password needed if you own it) |
| `LTCTL_NO_UDEV=1` | Linux: skip the udev rule |

To uninstall: `curl -fsSL https://raw.githubusercontent.com/j4ckxyz/ltctl/main/install.sh | sh -s -- --uninstall`

### Windows

In PowerShell:

```powershell
irm https://raw.githubusercontent.com/j4ckxyz/ltctl/main/install.ps1 | iex
```

From a PowerShell window opened with **Run as administrator**, this installs for all users in
`C:\Program Files\ltctl` and adds it to the system `PATH`. From a normal window it installs for
you only, in `%LOCALAPPDATA%\Programs\ltctl`. Open a new terminal afterwards. The amp needs no
driver on Windows. To uninstall, run the same command with `$env:LTCTL_UNINSTALL = "1"` set first.

### Manual download

Every [release](https://github.com/j4ckxyz/ltctl/releases) has an archive for each platform
(`ltctl-macos-arm64`, `ltctl-macos-x64`, `ltctl-linux-x64`, `ltctl-linux-arm64`,
`ltctl-windows-x64`, `ltctl-windows-arm64`) and a `SHA256SUMS` file. Each archive holds a single
self-contained executable; put it anywhere on your `PATH`.

## First run

**1. Install the catalogue.** To name amps and effects and convert knob values, ltctl needs the
amp and effect definitions from Fender Tone LT Desktop. They're Fender's, so they aren't
distributed with ltctl; instead ltctl reads them from your own copy, once:

```sh
ltctl setup
```

On a Mac this finds Fender Tone LT Desktop in Applications, or its installer `.dmg` in
Downloads, and reads the catalogue straight out of it. The app doesn't need to be able to run,
so this works on Apple silicon Macs without Rosetta. Fender Tone LT Desktop is a free download
from Fender. You can also point at it: `ltctl setup "~/Downloads/Fender Tone App.dmg"`.

On Windows or Linux, run `ltctl setup -o catalog.json` on any Mac, copy the file across and run
`ltctl setup catalog.json`.

Without the catalogue, ltctl can still list, back up, copy and push presets; creating presets
and showing knob values needs it.

**2. Connect the amp** with a USB cable, switch it on and quit Fender Tone LT Desktop (only one
program can use the amp at a time). Then check everything:

```console
$ ltctl doctor
ltctl 1.0.0 on darwin-arm64
ok  catalogue    Fender Tone LT Desktop 1.5.0
ok  usb          HID access works
ok  amp found    Mustang LT 25
ok  amp answers  Mustang LT25, firmware 2.1.4
```

## Quick start

```sh
ltctl status                        # which amp, which firmware, which preset is playing
ltctl list                          # all 60 slots with their signal chains
ltctl show 35                       # one preset, with every setting as the amp shows it
ltctl pull ~/amp-presets            # save every preset as a .preset file
ltctl backup                        # snapshot the whole amp into the backup folder
ltctl load 12                       # switch the amp to slot 12
ltctl audition "factory:Surf Music" # play a factory preset without saving it
ltctl audition --stop               # back to the stored preset
ltctl push tone.preset --slot empty # store a preset in the first empty slot
ltctl --help                        # every command
```

Anywhere a command takes a preset you can give a slot number (`35`), `current` (what the amp is
playing now), a factory preset (`factory:Surf Music`), a `.preset` file, or `-` for standard
input, so commands can be chained:

```sh
ltctl new --from 35 name="Solo Boost" amp.gain=7.5 | ltctl push - --slot empty
```

The full reference for every command and option is in [docs/COMMANDS.md](docs/COMMANDS.md).

## Creating and editing presets

A Mustang LT preset is a fixed chain of five positions:

```
stomp → mod → amp → delay → reverb
```

`ltctl new` starts from the amp's empty preset and applies settings written as `key=value`, in
order. Values are what the amp displays, not what it stores:

```sh
ltctl new "Brighton Rock" \
  stomp="5 band eq" stomp.low=-6 stomp.highmid=6 stomp.gain=10 \
  amp=ac30 amp.gain=7 amp.master=6.5 amp.treble=5.5 amp.mid=7 amp.cab="2x12 blue" amp.sag=more \
  delay=delay delay.time=800ms delay.feedback=5 delay.level=4 \
  reverb=plate reverb.level=3 \
  -o brighton.preset
```

| Key | Meaning | Example |
|---|---|---|
| `name` | Two display lines of up to 8 letters, digits or spaces | `name="Spread Wings"` |
| `<position>` | Choose the unit in a position; `none` empties it | `amp=ac30`, `delay=none` |
| `<position>.<parameter>` | Set a parameter, in display units | `amp.gain=6.5`, `delay.time=400ms` |
| `<position>.<parameter>=raw:…` | Set the exact stored value | `amp.volume=raw:-3` |

- Units can be named by the amp's display name (`"60S UK CLN"`), Fender's ID (`DUBS_Ac30Tb`) or
  any unique part of either (`ac30`).
- Parameters can be named by ID or display name, or any unique part: `amp.cab` means
  `amp.cabsimType`.
- Knobs take the 1 to 10 value shown on the amp; times take `ms` or `s`; lists take either the
  stored or the displayed option (`amp.noisegate=mid` or `amp.noisegate=medium`); switches take `on` or
  `off`.
- Choosing a unit resets that position to the unit's defaults, so set its parameters after it.
- Mistakes are explained, with the valid options:

```console
$ ltctl new "Test" amp=ac30 amp.cabinet=marshall
error: 60S UK CLN cabsimType can't be "marshall"
hint: options: none, 57champ, 65prince ('65 Princeton), ga15rvt ('66 GA-15), … 2x12c (2x12 Blue), 4x12m (4x12 75W), …
```

Explore what's available with `ltctl units` (every amp and effect), `ltctl units ac30` (one
unit's parameters, ranges and defaults) and `ltctl factory` (the factory library).

`ltctl set` changes an existing preset in place. On an amp slot, the slot is backed up and
rewritten; on a file, the file is updated:

```sh
ltctl set 35 amp.gain=7 reverb.level=3
ltctl set 35 delay=none --dry-run       # see the changes first
ltctl diff 35 ~/amp-presets/"35 Warm Lead.preset"
```

More detail, including JSON tone specs and how knob values map to stored values, is in
[docs/PRESETS.md](docs/PRESETS.md).

## Using ltctl from scripts and agents

ltctl follows the conventions in [Command Line Interface Guidelines](https://clig.dev/) and is
designed so that an AI agent can use it without supervision:

- `--json` on any command prints exactly one JSON object on standard output, including when
  something goes wrong:

  ```json
  {"error": {"code": "slot_not_empty", "message": "Slot 35 holds \"Warm Lead\".", "hint": "pass --replace to overwrite it (it is backed up first), or use --slot empty", "exitCode": 6}}
  ```

- Exit codes say what happened:

  | Code | Meaning |
  |---:|---|
  | 0 | Success |
  | 1 | Unexpected error |
  | 2 | Usage error (bad arguments) |
  | 3 | No amp connected |
  | 4 | Amp busy (another program has it) or no permission |
  | 5 | Invalid preset or setting |
  | 6 | Refused for safety (needs `--replace`, `--yes` or `--discard-edits`) |
  | 7 | Amp communication failed or timed out (safe to retry) |
  | 8 | Not found (file, factory preset, unit, catalogue) |

- Nothing ever prompts. Anything that could lose data needs an explicit flag, and `--dry-run`
  shows what would happen.
- Commands describe themselves: `ltctl guide` (a one-page manual for agents),
  `ltctl commands --json`, `ltctl units <unit> --json`.
- `ltctl markdown reference.md` writes a complete reference (every unit and parameter with its
  ranges and defaults, how to make presets, and the presets currently on the amp) to hand to an
  AI when asking it to design tones.

See [docs/AGENTS.md](docs/AGENTS.md) for the JSON shapes and example workflows.

## Safety

ltctl only sends messages that Fender Tone LT Desktop itself sends. It cannot update firmware or
factory-reset the amp, and never opens the amp's firmware-update mode.

- Reading never changes anything.
- `push` refuses to replace a slot that holds a preset unless you add `--replace`. `clear` and
  `restore` need `--yes`.
- Before any preset is replaced, renamed, swapped or cleared, the old one is saved to the backup
  folder (`ltctl doctor` shows where). `ltctl backup` snapshots the whole amp.
- Every write is verified by reading the slot back.
- `load` refuses to switch presets if the amp has unsaved changes made on its own knobs, unless
  you add `--discard-edits`.

| | macOS | Linux | Windows |
|---|---|---|---|
| Backups | `~/Library/Application Support/ToneLT/Backups` | `~/.local/share/tonelt/Backups` | `%APPDATA%\ToneLT\Backups` |
| Catalogue | `~/Library/Application Support/ToneLT` | `~/.local/share/tonelt` | `%APPDATA%\ToneLT` |
| Cache | `~/Library/Caches/ToneLT` | `~/.cache/tonelt` | `%LOCALAPPDATA%\ToneLT\Cache` |

Set `TONELT_HOME` to keep everything in one folder instead.

## How it works

The Mustang LT appears to a computer as a USB HID device with a vendor-defined interface, so
no driver is needed. Every message is a protobuf (`FenderMessageLT`), split into 64-byte reports
of up to 61 bytes each. A session starts with a sync handshake, reads what it needs and ends the
sync; while idle it sends a heartbeat every second. Presets travel as JSON describing a
five-node signal chain. The full details are in [docs/PROTOCOL.md](docs/PROTOCOL.md).

ltctl is written in TypeScript and runs on [Bun](https://bun.com). Releases are single
executables built with `bun build --compile`, so there is nothing else to install. USB access
uses the prebuilt [node-hid](https://github.com/node-hid/node-hid) addon, which wraps
[HIDAPI](https://github.com/libusb/hidapi). The addon for your platform is embedded in the
executable and copied to the cache folder on first run, because loading it from disk is faster
than loading it from inside the executable.

```
cli/src/
  main.ts      command dispatch          help.ts      help, guide, completions
  commands.ts  every command             cli.ts       output, errors, exit codes, references
  amp.ts       sessions and requests     protocol.ts  protobuf, messages, 64-byte framing
  hid.ts       USB HID via node-hid      preset.ts    preset JSON, names, validation
  catalog.ts   units, parameters, tapers editor.ts    key=value assignments
  summary.ts   descriptions and diffs    storage.ts   files, backups, cache
  extract.ts   reads the catalogue       markdown.ts  the agent reference
```

A command that talks to the amp takes about 90 ms: 20 ms to start, 15 ms to connect and about
35 ms per preset read (the amp sends 64 bytes per millisecond). Reading all 60 presets takes
about 2.3 s, so `list` prints rows as they arrive, and `--cached` answers from the last read
instantly.

## How it was made

Fender publishes no documentation for the amp's USB protocol, and the official app is closed
source. Everything here was worked out from the app's own executable, its behaviour, and careful
testing on a real amp:

1. **The message schema** was compiled into Fender Tone LT Desktop as protobuf descriptors.
   Extracting and decoding them gave the exact definition of all 67 message types.
2. **The framing** (the 64-byte report format, 61-byte chunks, the one-second heartbeat) came
   from disassembling the app's message encoder and sender, whose symbols were left in the
   executable. The open-source [LtAmp.py](https://github.com/benderhq/LtAmp.py) project
   confirmed it independently.
3. **The handshake** was found by experiment: the amp ignored every request until it received
   the sync message the official app sends first.
4. **The amp and effect catalogue**, Fender's factory presets and the curves that map knob
   positions to stored values were all in the executable too, as JSON and a small table of
   constants.
5. **Testing on the amp** was read-only at first. Writes were tested only on empty slots and
   undone afterwards, with the results compared byte for byte. That testing found the amp's own
   quirks, such as re-serialising stored JSON and never storing a switched-off effect.

The full story, with the tools and techniques used at each step, is in
[docs/HOW-IT-WAS-MADE.md](docs/HOW-IT-WAS-MADE.md).

## Troubleshooting

Run `ltctl doctor` first; it checks each piece in turn.

| Problem | Fix |
|---|---|
| `No Mustang LT amp is connected` | Use a data USB cable (some are charge-only), switch the amp on, and try another port. |
| `Another program is using the amp` | Quit Fender Tone LT Desktop (and the ToneLT app). |
| Linux: `No permission to open the amp` | Re-run the installer, or add the udev rule by hand (below), then unplug and replug the amp. |
| `The amp and effect catalogue is not installed` | Run `ltctl setup` (see [First run](#first-run)). |
| `The amp did not answer` | Retry. If it keeps happening, switch the amp off and on. Nothing was changed. |
| `The amp's active preset has unsaved edits` | Save or undo the change on the amp, or add `--discard-edits`. |

The Linux udev rule, if you installed ltctl by hand:

```sh
echo 'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1ed8", TAG+="uaccess", MODE="0660"' | sudo tee /etc/udev/rules.d/70-fender-lt.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Add `-v` to any command to log every USB message to standard error. When reporting a problem,
please include the output of `ltctl doctor` and, if relevant, the `-v` log.

## Building from source

You need [Bun](https://bun.com) 1.3 or later.

```sh
git clone https://github.com/j4ckxyz/ltctl && cd ltctl/cli
bun install
bun src/main.ts --help        # run from source
bun test                      # tests (no amp needed)
bunx tsc -p .                 # type-check
bun run build                 # executables for every platform in cli/dist/
bun run build --host          # just this machine
bun run docs                  # regenerate docs/COMMANDS.md
```

Releases are built by GitHub Actions when a `v*` tag is pushed: tests run, the executables are
built and packaged with checksums, and the installers are then tested on Linux, macOS and
Windows against the published release.

## The Mac app

This repository also contains **ToneLT**, a native SwiftUI app for Apple silicon Macs that
replaces Fender Tone LT Desktop's preset management. It shows the presets on the amp with their
signal chains and knobs, imports and exports `.preset` files, auditions factory presets and
exports the agent reference, and it shares the catalogue, cache and backups with ltctl. Build it
on a Mac with the Xcode command line tools and Bun:

```sh
scripts/build-app.sh          # build/ToneLT.app, with ltctl inside
```

## Licence and trademarks

ltctl is released under the [MIT licence](LICENSE). The release executables include node-hid,
HIDAPI and the Bun runtime; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

ltctl is an independent project, not affiliated with or endorsed by Fender Musical Instruments
Corporation. "Fender", "Mustang" and "Fender Tone" are trademarks of their respective owners.
No Fender software or data is included in this repository or its releases; the catalogue is
read from your own copy of Fender Tone LT Desktop. Using ltctl is at your own risk, although it
has been designed to be careful with your amp.

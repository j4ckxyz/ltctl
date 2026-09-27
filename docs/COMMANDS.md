# Command reference

Generated from the command table (`bun run docs`); the same text as `ltctl <command> --help`.

## Options for every command

| Option | Description |
|---|---|
| `--json` | Print one JSON object on stdout (errors too). |
| `-q`, `--quiet` | Print only essential output. |
| `-v`, `--verbose` | Log USB messages to stderr. |
| `--no-color` | Disable colours (also NO_COLOR=1). |
| `-h`, `--help` | Show help. |

## Reading

### ltctl status

Show the connected amp, its firmware and the active preset.

```
ltctl status [options]
```

Aliases: `info`

Uses the amp: yes. Changes the amp: no.

### ltctl list

List the amp's 60 preset slots.

```
ltctl list [options]
```

Aliases: `ls`

Rows stream as they are read (~2 s for all 60 over USB). --cached answers instantly from the last read.

| Option | Description |
|---|---|
| `--cached` | Use the last read instead of USB (instant; may be stale). |
| `--used` | Only slots holding a preset. |
| `--empty` | Only empty slots. |

Uses the amp: only for amp slots or `current`. Changes the amp: no.

```sh
ltctl list
ltctl list --empty --json
ltctl ls --cached
```

### ltctl show

Describe a preset in the amp's own units (knob values, unit names).

```
ltctl show <preset> [options]
```

<preset> is a slot number (1-60), current, factory:<name>, a .preset file, or - for stdin.

| Option | Description |
|---|---|
| `--raw` | Print the preset JSON exactly as stored. |
| `--cached` | Read amp slots from the cache instead of USB. |

Uses the amp: only for amp slots or `current`. Changes the amp: no.

```sh
ltctl show 35
ltctl show current --json
ltctl show "factory:Surf Music"
ltctl show tone.preset --raw
```

### ltctl diff

Compare two presets parameter by parameter.

```
ltctl diff <preset> <preset> [options]
```

Exits 0 whether or not they differ; check "identical" in --json output.

| Option | Description |
|---|---|
| `--cached` | Read amp slots from the cache instead of USB. |

Uses the amp: only for amp slots or `current`. Changes the amp: no.

```sh
ltctl diff 35 ~/backup/35-old.preset
ltctl diff 1 "factory:Fender Clean" --json
```

### ltctl pull

Download the amp's presets into a folder as .preset files.

```
ltctl pull [folder] [options]
```

Aliases: `export-all`

Writes "NN Name.preset" per used slot plus index.json (every slot, summarised). Older files for a slot are replaced. Default folder: ./amp-presets

| Option | Description |
|---|---|
| `--slots <list>` | Only these slots, e.g. 1-10,35. |
| `--include-empty` | Also write empty slots. |

Uses the amp: yes. Changes the amp: no.

```sh
ltctl pull ~/amp
ltctl pull ~/amp --slots 30-40 --json
```

### ltctl export

Save one preset as a .preset file.

```
ltctl export <preset> [options]
```

| Option | Description |
|---|---|
| `-o`, `--output <file>` | Output file or - for stdout (default "NN Name.preset"). |

Uses the amp: only for amp slots or `current`. Changes the amp: no.

```sh
ltctl export 35
ltctl export 35 -o queen.preset
ltctl export "factory:Surf Music" -o -
```

### ltctl backup

Snapshot every used slot into the backup folder (or a folder you name).

```
ltctl backup [folder] [options]
```

Uses the amp: yes. Changes the amp: no.

## Creating and editing presets

### ltctl new

Create a preset from assignments, in the amp's own units.

```
ltctl new [name] [key=value…] [options]
```

Starts from the amp's EMPTY template (or --from another preset). Writes JSON to stdout unless -o is given.



Assignments (key=value, applied in order; values are what the amp shows):
  name=<text>                          two lines of 8 characters, e.g. "Spread Wings"
  stomp|mod|amp|delay|reverb=<unit>    menu name, FenderId or unique part (ac30); none = empty
  <position>.<parameter>=<value>       amp.gain=6.5  delay.time=400ms  amp.cabinet="2x12 blue"
  <position>.<parameter>=raw:<value>   exact stored value

Choosing a unit resets its parameters to defaults, so set parameters after it.

See `ltctl units <unit>` for a unit's parameters and options.

| Option | Description |
|---|---|
| `--from <preset>` | Start from this preset (slot, factory:<name>, file). |
| `--spec <file>` | Apply a JSON tone spec (file or -) before the assignments. |
| `-o`, `--output <file>` | Output file, or - for stdout (default). |

Uses the amp: only for amp slots or `current`. Changes the amp: no.

```sh
ltctl new "Brighton Rock" amp=ac30 amp.gain=7 stomp=overdrive stomp.gain=2.5 delay=delay delay.time=800ms -o brighton.preset
ltctl new --from 35 name="Solo Boost" amp.gain=7.5 | ltctl push - --slot empty
ltctl new --spec tone.json -o tone.preset
```

### ltctl set

Change parameters of an amp slot or a preset file.

```
ltctl set <preset> <key=value…> [options]
```

On a slot, the slot is backed up and rewritten; on a file, the file is updated (or written to -o).



Assignments (key=value, applied in order; values are what the amp shows):
  name=<text>                          two lines of 8 characters, e.g. "Spread Wings"
  stomp|mod|amp|delay|reverb=<unit>    menu name, FenderId or unique part (ac30); none = empty
  <position>.<parameter>=<value>       amp.gain=6.5  delay.time=400ms  amp.cabinet="2x12 blue"
  <position>.<parameter>=raw:<value>   exact stored value

Choosing a unit resets its parameters to defaults, so set parameters after it.

See `ltctl units <unit>` for a unit's parameters and options.

| Option | Description |
|---|---|
| `--spec <file>` | Apply a JSON tone spec (file or -) first. |
| `-o`, `--output <file>` | Write the result here (file or -) instead of back to the source. |
| `--dry-run` | Show the changes without writing anything. |

Uses the amp: only for amp slots or `current`. Changes the amp: yes (backed up and verified).

```sh
ltctl set 35 amp.gain=7 reverb.level=3
ltctl set 35 delay=none --dry-run
ltctl set tone.preset amp="deluxe cln" amp.volume=8 -o tone2.preset
```

## Changing the amp

### ltctl push

Store a preset in an amp slot.

```
ltctl push <preset> [options]
```

Aliases: `import`

Refuses to replace a slot that holds a preset unless --replace is given. Anything replaced is backed up, and the slot is read back to verify.

| Option | Description |
|---|---|
| `--slot <n|empty>` | Target slot 1-60, or "empty" for the first empty slot. Required. |
| `--replace` | Allow replacing a slot that holds a preset. |
| `--dry-run` | Show what would happen without writing. |
| `--load` | Switch the amp to the slot afterwards. |

Uses the amp: yes. Changes the amp: yes (backed up and verified).

```sh
ltctl push brighton.preset --slot empty
ltctl push brighton.preset --slot 50 --dry-run
ltctl push "factory:Surf Music" --slot 51 --load
ltctl push 35 --slot 52                  # copy slot 35 to 52
ltctl new … | ltctl push - --slot 35 --replace
```

### ltctl rename

Rename a preset on the amp.

```
ltctl rename <slot> <name> [options]
```

Names are two lines of 8 characters (letters, digits, spaces).

| Option | Description |
|---|---|
| `--dry-run` | Show the result without writing. |

Uses the amp: yes. Changes the amp: yes (backed up and verified).

```sh
ltctl rename 35 "Spread Wings"
```

### ltctl swap

Swap the presets in two slots (both backed up first).

```
ltctl swap <slot> <slot> [options]
```

| Option | Description |
|---|---|
| `--dry-run` | Show the result without writing. |

Uses the amp: yes. Changes the amp: yes (backed up and verified).

### ltctl clear

Empty a slot (the preset is backed up first). Requires --yes.

```
ltctl clear <slot> [options]
```

| Option | Description |
|---|---|
| `--yes` | Confirm clearing the slot. |

Uses the amp: yes. Changes the amp: yes (backed up and verified).

```sh
ltctl clear 60 --yes
```

### ltctl restore

Write a pulled or backed-up folder back to the amp (only slots that differ).

```
ltctl restore <folder> [options]
```

Reads "NN Name.preset" files, compares each with the amp and rewrites the slots that differ, after snapshotting the whole amp. Requires --yes unless --dry-run.

| Option | Description |
|---|---|
| `--dry-run` | Only report what would change. |
| `--yes` | Confirm writing to the amp. |

Uses the amp: yes. Changes the amp: yes (backed up and verified).

```sh
ltctl restore ~/amp --dry-run
ltctl restore ~/amp --yes
```

### ltctl load

Switch the amp to a stored preset.

```
ltctl load <slot> [options]
```

| Option | Description |
|---|---|
| `--discard-edits` | Switch even if the active preset has unsaved edits (they are lost). |

Uses the amp: yes. Changes the amp: no.

### ltctl audition

Play a preset on the amp without saving it.

```
ltctl audition <preset> | --stop [options]
```

The amp plays it until another preset is chosen or --stop returns to the stored preset. Nothing is written to any slot.

| Option | Description |
|---|---|
| `--stop` | End the audition and reload the stored preset. |

Uses the amp: yes. Changes the amp: no.

```sh
ltctl audition brighton.preset
ltctl audition "factory:Surf Music"
ltctl audition --stop
```

## Reference

### ltctl units

List the amps and effects the LT offers, or one unit's parameters.

```
ltctl units [position|unit] [options]
```

Aliases: `catalog`

Uses the amp: no. Changes the amp: no.

```sh
ltctl units
ltctl units amp
ltctl units ac30
ltctl units delay --json
```

### ltctl factory

List Fender's factory preset library (use as factory:<name>).

```
ltctl factory [search] [options]
```

Uses the amp: no. Changes the amp: no.

```sh
ltctl factory
ltctl factory fuzz --json
ltctl show "factory:Surf Music"
```

### ltctl validate

Check preset files before pushing them.

```
ltctl validate <preset…> [options]
```

Uses the amp: only for amp slots or `current`. Changes the amp: no.

### ltctl markdown

Write the agent reference: every amp/effect, parameters, and the amp's presets.

```
ltctl markdown [file] [options]
```

Writes to stdout unless a file is given. Reads the amp's presets if it is connected.

| Option | Description |
|---|---|
| `--no-factory` | Leave out Fender's 100-preset factory library. |
| `--offline` | Don't read the amp (uses cached presets if any). |

Uses the amp: only for amp slots or `current`. Changes the amp: no.

## Setup

### ltctl setup

Install the amp and effect catalogue from your copy of Fender Tone LT Desktop.

```
ltctl setup [app|dmg|catalog.json] [options]
```

Reads the amp and effect definitions and Fender's factory presets out of Fender Tone LT Desktop (the installed app or its installer .dmg, on macOS) and saves them as catalog.json for this user. With no argument it looks in /Applications, ~/Applications, ~/Downloads and ~/Desktop. On Windows or Linux, run setup on a Mac and pass the resulting catalog.json. The catalogue is saved to ~/Library/Application Support/ToneLT (macOS), ~/.local/share/tonelt (Linux) or %APPDATA%\ToneLT (Windows); `ltctl doctor` shows where. Nothing from Fender is shipped with ltctl.

| Option | Description |
|---|---|
| `-o`, `--output <file>` | Write catalog.json here instead of installing it. |

Uses the amp: no. Changes the amp: no.

```sh
ltctl setup
ltctl setup "/Applications/Fender Tone LT Desktop.app"
ltctl setup "~/Downloads/Fender Tone App.dmg"
ltctl setup catalog.json
```

### ltctl doctor

Check the catalogue, USB access and the amp connection.

```
ltctl doctor [options]
```

Prints what ltctl can find and use. Include its output when reporting a problem.

Uses the amp: only for amp slots or `current`. Changes the amp: no.

## The guide (`ltctl guide`)

```
ltctl guide: using ltctl from scripts and agents

WORKFLOW
  ltctl setup                         once: install the amp and effect catalogue from Fender Tone LT Desktop
  ltctl doctor --json                 check the catalogue, USB access and the amp
  ltctl status --json                 is an amp connected? which preset is active?
  ltctl list --json                   all 60 slots (≈2 s); --cached is instant but may be stale
  ltctl show 35 --json                one preset with knob values in the amp's units
  ltctl units ac30                    a unit's parameters, ranges and options
  ltctl new "Name" amp=ac30 amp.gain=6.5 … -o x.preset    create a preset file
  ltctl audition x.preset             hear it (nothing saved); ltctl audition --stop
  ltctl push x.preset --slot empty    store it in the first empty slot
  ltctl set 35 amp.gain=7             edit a stored preset (backed up first)
  ltctl markdown ref.md               full reference: every unit and parameter, all presets

PRESET REFERENCES
  35 (slot 1-60) · current (the amp's live preset) · factory:<name> · path/to/file.preset · - (stdin)

ASSIGNMENTS (new, set)
  name=<text>                         two lines of 8 characters, letters/digits/spaces
  stomp|mod|amp|delay|reverb=<unit>   menu name ("60S UK CLN"), FenderId or unique part; none = empty
  <position>.<param>=<value>          display values: knobs 1–10, 400ms, +10%, on/off, list option names
  <position>.<param>=raw:<value>      exact stored value
  Choosing a unit resets its parameters, so set parameters after it. Errors list valid options.
  --spec file.json takes {"name": …, "amp": {"unit": "ac30", "gain": 6}, "delay": null} or `show --json` output.

OUTPUT
  --json: exactly one JSON object on stdout, for success and failure. Errors look like
  {"error": {"code": "slot_not_empty", "message": "…", "hint": "…", "exitCode": 6}}.
  Human text goes to stdout, progress and notes to stderr. Nothing ever prompts.

SAFETY
  Reads never change the amp. push refuses to replace a used slot without --replace; clear and
  restore need --yes; set/push/rename/swap/restore/clear back up what they replace
  (`ltctl backup` snapshots everything) and verify writes by reading the slot back.
  --dry-run shows what would happen. Only one program can use the amp at a time.

EXIT CODES
  0 ok · 1 unexpected error · 2 usage · 3 no amp connected · 4 amp busy/no permission
  5 invalid preset or input · 6 refused (needs --replace/--yes/--discard-edits) · 7 amp I/O or timeout (retry)
  8 not found (file, slot not cached, factory preset, unit, catalogue)
```

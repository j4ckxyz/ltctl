# Using ltctl from scripts and AI agents

ltctl is designed to be operated by programs as safely as by people. This page covers the
contract an agent can rely on. `ltctl guide` prints a condensed version, and
`ltctl commands --json` lists every command and option.

## The contract

- **Output.** With `--json`, a command prints exactly one JSON object on standard output, and
  nothing else, whether it succeeds or fails. Without it, human-readable text goes to standard
  output and notes and progress go to standard error. Field names are stable.
- **Errors.** A failure prints `{"error": {...}}` and exits with a non-zero code:

  ```json
  {"error": {"code": "not_found", "message": "No such file: song.preset", "hint": null, "exitCode": 8}}
  ```

  `code` is a stable identifier, `message` is for people and `hint` suggests the fix.
- **Exit codes.**

  | Code | Meaning | What to do |
  |---:|---|---|
  | 0 | Success | |
  | 1 | Unexpected error | Report it |
  | 2 | Usage error | Fix the arguments; `ltctl <command> --help` |
  | 3 | No amp connected | Ask the user to connect and switch on the amp |
  | 4 | Amp busy or no permission | Ask the user to quit Fender Tone LT Desktop |
  | 5 | Invalid preset or setting | Read `hint`, which lists valid options |
  | 6 | Refused for safety | Only add `--replace`, `--yes` or `--discard-edits` if the user wants that |
  | 7 | Amp I/O or timeout | Safe to retry; nothing was changed unless the output said so |
  | 8 | Not found | Check the file, slot, unit or factory preset name |

- **No prompts.** ltctl never waits for input. Anything that could lose data needs an explicit
  flag, and `--dry-run` previews changes.
- **Backups.** Every command that replaces a preset saves the old one first and reports where
  (`"backup"`, or `"backups"` for `swap`, in the JSON; `restore` snapshots the whole amp). Every
  write is verified by reading the slot back.

## Discovering what's possible

| Command | Returns |
|---|---|
| `ltctl doctor --json` | whether the catalogue, USB and amp are working |
| `ltctl status --json` | the amp model, firmware and active preset |
| `ltctl list --json` | every slot: name, whether it's empty, whether it's active, its chain |
| `ltctl units --json` | every unit available in each position |
| `ltctl units <unit> --json` | a unit's parameters with ranges, options and defaults |
| `ltctl factory --json` | Fender's factory presets, usable as `factory:<name>` |
| `ltctl markdown` | a complete Markdown reference: units, parameters, rules and the amp's presets |

For an AI designing tones, `ltctl markdown reference.md` is the best starting point: it's a
self-contained document with everything needed.

## Preset JSON (`ltctl show --json`)

```json
{
  "slot": null,
  "name": "Spread Wings",
  "ampName": "SPREAD  WINGS   ",
  "empty": false,
  "chain": [
    { "position": "mod", "unitId": "DUBS_Passthru", "unit": "none", "empty": true, "params": [] },
    {
      "position": "amp",
      "unitId": "DUBS_Ac30Tb",
      "unit": "60S UK CLN",
      "empty": false,
      "params": [
        { "id": "gain", "name": "GAIN", "display": "6.0", "value": 6, "raw": 0.555556, "panel": true },
        { "id": "volume", "name": "VOLUME", "display": "9.4", "value": 9.42, "raw": -1.170975, "panel": true }
      ]
    }
  ]
}
```

(Shortened: `chain` always has all five positions, and `params` every stored parameter.)

- `display` is what the amp shows, `value` its number (for continuous parameters) and `raw` the
  stored value.
- `panel: false` marks settings stored in the preset but not shown on the amp's panel.
- `slot` is null for presets that aren't on the amp (files, factory presets, standard input).
- This JSON can be fed back with `ltctl new --spec -`.

## Example workflows

Make a new sound, check it, let the user hear it, then store it:

```sh
ltctl new "Warm Lead" amp="deluxe cln" amp.gain=7 delay=echo delay.time=350ms -o warm.preset --json
ltctl validate warm.preset --json
ltctl audition warm.preset          # the user listens; nothing is saved
ltctl audition --stop
ltctl push warm.preset --slot empty --json
```

Adjust a stored preset after feedback such as "a bit less gain and more reverb":

```sh
ltctl show 49 --json                                  # read the current values
ltctl set 49 amp.gain=6 reverb.level=4 --dry-run --json
ltctl set 49 amp.gain=6 reverb.level=4 --json         # backed up, then written
```

Back up and restore:

```sh
ltctl pull ./amp --json          # every preset, plus index.json
ltctl restore ./amp --dry-run --json
ltctl restore ./amp --yes --json
```

## Tips

- `ltctl list --cached --json` answers instantly from the last read; use it to find empty slots
  or names without waiting for USB, then confirm with a live command.
- `--slot empty` finds the first empty slot for you.
- Only one program can use the amp at a time, so run ltctl commands one after another, not in
  parallel.
- Unit and parameter names are forgiving (`ac30`, `cab`, `treble`), and errors list the valid
  choices, so a failed assignment tells you how to fix it.

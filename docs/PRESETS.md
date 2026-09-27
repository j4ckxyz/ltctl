# Presets

## What a preset is

Every Mustang LT preset is the same fixed chain of five positions:

| Position | Where | Choices |
|---|---|---|
| `stomp` | before the amp | none, overdrives, fuzzes, compressor, 5-band EQ and more |
| `mod` | before the amp | none, chorus, flanger, phaser, tremolo, vibratone, filters |
| `amp` | | one of 20 amp models (never empty) |
| `delay` | after the amp | none, delay, reverse delay, echo |
| `reverb` | after the amp | none, large hall, small room, spring, plate, arena |

`ltctl units` lists the exact choices, and `ltctl units <name>` shows a unit's parameters.

Each preset has a name of up to 16 characters shown on two lines of 8, using letters, digits
and spaces. ltctl lays names out for you: "Spread Wings" becomes `SPREAD` on the first line and
`WINGS` on the second.

On disk a preset is a `.preset` file containing the amp's JSON, exactly the format Fender Tone
LT Desktop exports, so files can be shared between the two.

## Referring to presets

Anywhere ltctl takes a preset, you can give:

| Form | Meaning |
|---|---|
| `35` | amp slot 35 (slots are 1 to 60) |
| `current` | what the amp is playing now, including unsaved changes made on its knobs |
| `factory:Surf Music` | a preset from Fender's factory library (any unique part of the name works) |
| `tone.preset` | a file |
| `-` | standard input |

## Creating presets

```sh
ltctl new "Clean Chime" amp="twin clean" amp.gain=3 amp.volume=7 amp.treble=6.5 \
  mod=chorus mod.level=4 mod.speed=2 reverb=spring reverb.level=4 -o chime.preset
```

`new` starts from the amp's empty preset, or from another preset with `--from`, and applies each
`key=value` in order.

### Keys

| Key | Example | Notes |
|---|---|---|
| `name` | `name="Spread Wings"` | A first argument without `=` is also taken as the name |
| `<position>` | `amp=ac30`, `delay=none` | Chooses the unit and resets that position to its defaults |
| `<position>.<parameter>` | `amp.gain=6.5` | A display value |
| `<position>.<parameter>=raw:<value>` | `amp.volume=raw:-3` | The exact stored value |

Units can be named by what the amp displays (`"60S UK CLN"`), by Fender's identifier
(`DUBS_Ac30Tb`), by the fuller name Fender Tone uses (`"60S UK CLEAN"`), or by any part of these
that matches only one unit (`ac30`). `none`, `off` or `empty` leave an effect position empty.

Parameters can be named by identifier (`treb`), display name (`treble`) or any part that
matches only one parameter (`cab` for `cabsimType`). If a name matches several, the error lists
them.

### Values

| Parameter type | What to write | Examples |
|---|---|---|
| Knob | the number shown on the amp, usually 1 to 10 | `amp.gain=6.5` |
| Time | milliseconds or seconds | `delay.time=400ms`, `delay.time=0.4s` |
| Level in dB or % | the number, with or without its unit | `stomp.low=-6`, `amp.bias=+10%` |
| List | the stored option or the displayed one | `amp.cab=2x12c`, `amp.cab="2x12 blue"` |
| Switch | `on` or `off` | `amp.bright=off` |

Values outside a parameter's range are rejected with the valid range. Setting a delay time also
updates the tap-tempo value stored with it.

### Settings the amp hides

Some settings are stored in every preset but aren't on the amp's panel, such as the cabinet,
noise gate, power supply sag and tube bias. ltctl shows and sets them like any other parameter;
`ltctl show` lists them on a second line under each unit, and `ltctl units` marks them
"advanced".

## Editing presets

```sh
ltctl set 35 amp.gain=7 reverb.level=3            # a slot: backed up, rewritten, verified
ltctl set 35 delay=none --dry-run                 # just show what would change
ltctl set tone.preset amp="deluxe cln" -o tone2.preset  # a file, written to a new file
ltctl rename 35 "Spread Wings"
ltctl swap 12 49
```

`ltctl diff <preset> <preset>` compares any two presets in display terms.

## Tone specs (JSON)

`new` and `set` also take `--spec file.json` (or `--spec -` for standard input), applied before
any command-line assignments. The simplest form mirrors the keys:

```json
{
  "name": "Spread Wings",
  "stomp": { "unit": "5 band eq", "low": -6, "highmid": 6, "gain": 9 },
  "amp": { "unit": "ac30", "gain": 6, "treble": 5.8, "bass": 5, "cab": "2x12 blue" },
  "delay": null,
  "reverb": { "unit": "small room", "level": 2.5 }
}
```

`null` empties a position. The output of `ltctl show --json` is also accepted, using its stored
values, so a preset can be exported, edited as JSON and rebuilt:

```sh
ltctl show 35 --json > tone.json
# edit tone.json
ltctl new --spec tone.json -o tone.preset
```

## How knob values become stored values

Each continuous parameter has a stored range and a display range. For example the amp volume is
stored in decibels from -60 to 0 but shown as 1 to 10. Fender maps between them with a curve (a
taper), so knob position 5 is not halfway in decibels. ltctl uses the same curves, recovered
from Fender Tone; [PROTOCOL.md](PROTOCOL.md#parameter-tapers) lists them, and
`ltctl markdown` prints the stored value for each whole knob position of every non-linear
parameter.

## Example: Brian May tones

These were designed from research into Brian May's equipment for particular Queen recordings.
The Mustang LT has no treble booster, so a 5-band EQ in the stomp position plays that role: cut
lows, lifted upper mids and up to +12 dB of level, driving the AC30 model into saturation as a
Rangemaster-style booster drives a real AC30.

```sh
# An all-round Brian May sound for playing along
ltctl new "Queen Tone" stomp="5 band eq" stomp.low=-6 stomp.lowmid=-2 stomp.mid=3 stomp.highmid=6 stomp.high=3 stomp.gain=10 \
  amp=ac30 amp.gain=6.5 amp.master=6.5 amp.volume=8.5 amp.treble=5.5 amp.mid=6.5 amp.bass=4.5 amp.bright=off amp.cut=40 amp.sag=more amp.cab="2x12 blue" \
  delay=delay delay.time=400ms delay.level=2 delay.feedback=2 delay.tone=4 reverb="small room" reverb.level=2.5 reverb.decay=3.5 -o queen.preset

# Bohemian Rhapsody, the first solo (1975): booster into a cranked AC30, no effects boxes
ltctl new "Bohemian Solo" stomp="5 band eq" stomp.low=-6 stomp.lowmid=-1 stomp.mid=3 stomp.highmid=5 stomp.high=2 stomp.gain=9 \
  amp=ac30 amp.gain=7 amp.master=6.5 amp.volume=8 amp.treble=5 amp.mid=7 amp.bass=4.5 amp.bright=off amp.cut=45 amp.sag=more amp.cab="2x12 blue" \
  delay=none reverb=plate reverb.level=2.5 reverb.decay=4 reverb.tone=4.5 -o bohemian-solo.preset

# Hammer to Fall at Live Aid (1985): hotter booster plus solo boost, chorus and delay in the mix
ltctl new "Hammer Live Aid" stomp="5 band eq" stomp.low=-5 stomp.mid=4 stomp.highmid=7 stomp.high=4 stomp.gain=12 \
  mod=chorus mod.level=4 mod.speed=2 mod.depth=3.5 \
  amp=ac30 amp.gain=8.5 amp.master=7.5 amp.volume=7.5 amp.treble=6 amp.mid=7 amp.bass=5 amp.bright=off amp.cut=40 amp.sag=more amp.cab="2x12 blue" \
  delay=delay delay.time=440ms delay.level=3 delay.feedback=2.5 reverb=arena reverb.level=2.5 reverb.decay=4 -o hammer.preset

# Keep Yourself Alive, the intro: out-of-phase pickups and tape phasing
ltctl new "Keep Alive" stomp="5 band eq" stomp.low=-9 stomp.lowmid=-4 stomp.mid=2 stomp.highmid=7 stomp.high=5 stomp.gain=9 \
  mod=flanger mod.level=8 mod.speed=1.3 mod.depth=8 mod.feedback=4 \
  amp=ac30 amp.gain=6.5 amp.master=6 amp.volume=8 amp.treble=5.5 amp.mid=6 amp.bass=4 amp.bright=off amp.cut=35 amp.sag=more amp.cab="2x12 blue" \
  delay=none reverb="small room" reverb.level=2 reverb.decay=3 -o keep-alive.preset
```

Brian May uses the bridge and middle pickups together; on a standard guitar, the bridge pickup
or bridge and middle together get closest.

# Mustang LT USB protocol

How ltctl (and the ToneLT Mac app) talk to a Fender Mustang LT. Recovered from Fender Tone LT
Desktop 1.5.0 (`com.fenderdigital.tonedesktop`, an x86_64 JUCE application using hidapi and
protobuf) and confirmed against a Mustang LT25 running firmware 2.1.4. See
[HOW-IT-WAS-MADE.md](HOW-IT-WAS-MADE.md) for how each part was worked out.

## Transport

- USB HID, vendor ID `0x1ED8`. Fender Tone accepts the product IDs `0x32` to `0x38`, `0x45` and
  `0x46` (`fmic::LTMessageManager::enumerateDevices`). The LT25 is `0x0037`. Firmware-update
  (bootloader) IDs are not in that list, and ltctl never opens them.
- A vendor-defined interface: usage page `0xFF00`, usage 1, 64-byte input and output reports,
  no report IDs. It needs no driver on any operating system.
- Each report is `[tag, length, payload…]`, padded with zeros to 64 bytes:
  - `0x33`: the first chunk of a message that spans several reports
  - `0x34`: a continuation chunk
  - `0x35`: the last chunk, or the only one
- At most 61 payload bytes per report, and at most 4000 bytes per message (the
  `FenderMessageLTEncoder` MTU).
- Input reports from the amp arrive with an extra `0x00` byte in front of the tag.
- The host sends a heartbeat after one second without traffic (`LTMessageManager`, whose timer
  is `0x3B9ACA00` ns).

## Messages

Every payload is one `FenderMessageLT` protobuf (proto2). Field 1 is `responseType`
(`UNSOLICITED = 0`, `NOT_LAST_ACK = 1`, `IS_LAST_ACK = 2`), and exactly one other field carries
the message. The schema was rebuilt from the `FileDescriptorProto`s compiled into the app. The
fields ltctl uses:

| Field | Message | Direction | Body |
|---:|---|---|---|
| 31 | PresetJSONMessage | amp to host | `data` (1, string), `slotIndex` (2) |
| 32 | CurrentPresetStatus | amp to host | `currentPresetData` (1), `currentSlotIndex` (2), `currentPresetDirtyStatus` (3) |
| 33 | LoadPreset | host to amp | `presetIndex` (1) |
| 37 | CurrentLoadedPresetIndexStatus | amp to host | `currentLoadedPresetIndex` (1) |
| 38 | PresetEditedStatus | amp to host | `presetEdited` (1) |
| 50 | PresetSavedStatus | amp to host | `name` (1), `slot` (2) |
| 55 | SavePresetAs | host to amp | `presetData` (1), `isLoadPreset` (2), `presetSlot` (3) |
| 56 | NewPresetSavedStatus | amp to host | `presetData` (1), `presetSlot` (2) |
| 58, 59 | AuditionPreset, AuditionPresetStatus | both | `presetData` (1) |
| 60, 61 | ExitAuditionPreset, ExitAuditionPresetStatus | both | `exit`, `isSuccess` (1) |
| 100, 101 | ProductIdentificationStatus, Request | both | `id` (1), for example `mustang-lt-25` |
| 102, 103 | FirmwareVersionRequest, Status | both | `version` (1), for example `2.1.4` |
| 104 | CurrentPresetRequest | host to amp | `request` (1) |
| 105 | RetrievePreset | host to amp | `slot` (1) |
| 113 | ModalStatusMessage | both | `context` (1), `state` (2) |
| 200 | UnsupportedMessageStatus | amp to host | `status` (1), an error code |
| 201 | Heartbeat | host to amp | `dummyField` (1) |
| 202, 203 | ConnectionStatusRequest, ConnectionStatus | both | `isConnected` (1) |

`FenderMessageLT` defines more messages that ltctl deliberately never sends: firmware flashing,
factory restore, parameter edits, USB and line-out gain, quick-access slot and footswitch
settings, and the frame-buffer and loopback test messages. Renaming, swapping and clearing are
done with `SavePresetAs`, the same message Fender Tone's Paste and "Duplicate Preset to My Amp"
use, so every change is a plain preset write that can be checked by reading it back.

## Session

1. Open the HID interface (non-exclusively).
2. Send `ModalStatusMessage{SYNC_BEGIN, OK}`. The amp echoes it. Until then it answers nothing
   except `ConnectionStatusRequest` (with `isConnected = false`).
3. Identify the amp: `FirmwareVersionRequest`, `ProductIdentificationRequest`.
4. Read presets with `RetrievePreset{slot}`. Slots are numbered **1 to 60** (slot 0 is treated as
   1). Each reply is a `PresetJSONMessage` for the same slot.
5. Send `ModalStatusMessage{SYNC_END, OK}`; the amp echoes it. Fender Tone only changes the amp
   after this point, and so does ltctl.
6. Send a heartbeat every second while idle.

### Timing

The amp is a full-speed USB device and sends one 64-byte report per millisecond, so a preset of
about 2 KB takes roughly 35 ms to arrive. Connecting takes about 15 ms. Reading all 60 slots one
at a time takes 2.39 s; with two requests in flight it takes 2.25 s. With eight in flight the amp
starts dropping requests, so ltctl keeps two in flight and retries a read that times out.

## Observed behaviour (LT25, firmware 2.1.4)

- `SavePresetAs` is answered with `NewPresetSavedStatus`. The amp re-serialises the JSON
  compactly when it stores it, so whitespace is dropped.
- The amp sets `bypassType` itself: delay and reverb units are always stored as `"Pre"`.
- Stored presets never keep `"bypass": true`: the amp saves every effect switched on. To leave
  an effect out, put `DUBS_Passthru` in its position.
- `LoadPreset` is answered with `PresetEditedStatus(false)` and
  `CurrentLoadedPresetIndexStatus`.
- `AuditionPreset` is answered with `PresetEditedStatus(true)` and `AuditionPresetStatus`. After
  `ExitAuditionPreset` the amp keeps playing the auditioned sound as an unsaved edit of the active
  slot, so ltctl reloads the stored preset with `LoadPreset`.
- Turning the preset knob on the amp sends `CurrentLoadedPresetIndexStatus` unprompted.

## Presets

A preset is JSON with `"nodeType": "preset"`, an `info` block and an `audioGraph` of five
`dspUnit` nodes in a fixed order: `stomp`, `mod`, `amp`, `delay`, `reverb`. `info.displayName`
is exactly 16 characters: two 8-character fields shown on the amp's two display lines, each
padded with spaces, for example `"FENDER  CLEAN   "`. `DUBS_Passthru` marks an empty effect
position; the amp position can never be empty. Fender Tone's Export Preset writes this JSON to a
`.preset` file (`RootLevelComponent::savePresetToDisk`), and ltctl's files are the same.

## Catalogue data

`ltctl setup` reads these C strings out of the Fender Tone LT Desktop executable, finding them
through its Mach-O symbol table:

- `fmic::dubs::lt::mustang::*Default`: the LT's amp and effect definitions (the parameters its
  own interface shows)
- `fmic::dubs::gt::*Default`: fuller definitions of the same units, with every stored parameter
  (cabinet, noise gate, sag, bias and so on)
- `fmic::pp::lt::PP_MustangLT`: which units the LT offers in each position, with the names on
  the amp's display
- `fmic::presets::lt::mustang::*`: Fender's 100-preset factory library and the EMPTY template

### Parameter tapers

Each continuous parameter has a stored range (`min` to `max`), a display range (for example 1 to
10) and a taper for each. `StandardTaper` builds tapers from the `taperData` table. With
`E(k, x) = (k^x - 1) / (k - 1)` and its inverse `L(k, x) = ln(x(k - 1) + 1) / ln k`:

| Name | Curve |
|---|---|
| `t50` | linear |
| `tNN` | `E(a, x)`, which reads NN% at half travel |
| `tNNi` | `L(a, x)`, the inverse of `tNN` |
| `tNNr` | `L(b, x)`, the reverse of `tNN` |
| `tNNri` | `E(b, x)` |
| `...s` | an S-curve made of two halves of the curve |

| NN | a | b |
|---:|---:|---:|
| 10 | 81 | 1013.99 |
| 15 | 32.111 | 94.725 |
| 20 | 16 | 26.61 |
| 25 | 9 | 11.4445 |
| 30 | 5.44445 | 6.05615 |
| 35 | 3.44899 | 3.5918 |
| 40 | 2.25 | 2.27541 |
| 45 | 1.49383 | 1.49585 |

The display value is `dmin + (dmax - dmin) · R((raw - min) / (max - min))`, where `R` is the
display taper. In every LT definition the display taper is the inverse of the stored one, so
the numbers the amp shows are linear in knob rotation.

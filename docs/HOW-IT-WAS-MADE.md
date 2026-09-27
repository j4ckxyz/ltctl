# How ltctl was made

Fender publishes nothing about how Fender Tone LT Desktop talks to a Mustang LT, and the app is
closed source. This is how the protocol, the amp and effect catalogue and the amp's quirks were
worked out, and how ltctl was then built and tested. Two rules applied throughout: **never do
anything destructive to the amp**, and **never send the amp anything the official app doesn't
send**.

## 1. Looking at the official app

Fender Tone LT Desktop 1.5.0 for macOS is a single 182 MB x86_64 executable. Its strings showed
three useful things straight away:

- it's a [JUCE](https://juce.com) application that uses [HIDAPI](https://github.com/libusb/hidapi)
  for USB, so the amp is a USB HID device;
- it uses Google's protobuf, and file names such as `PresetJSONMessage.proto` and
  `FenderMessageLT.pb.cpp` suggested the messages were protobufs;
- its C++ symbols were still present (`nm` listed 116,000 of them, such as
  `fmic::LTMessageManager::attemptBeginMessageSend()`), which makes disassembly readable.

`ioreg` confirmed the amp enumerates as vendor `0x1ED8`, product `0x0037`, with a
vendor-defined HID interface (usage page `0xFF00`) of 64-byte input and output reports.

## 2. The message schema

Protobuf's C++ code generator embeds each `.proto` file in the program as a serialised
`FileDescriptorProto`, so that the library can use reflection. These are binary blobs that
begin with the file's name, for example `\x0a\x15PresetJSONMessage.proto`. Scanning the
executable for that pattern, walking each candidate's fields to find where it ended, and parsing
it with the Python protobuf library recovered **67 `.proto` files**: the complete schema, with
field names and numbers. The root message is `FenderMessageLT`: a `responseType` enum plus a
`oneof` of 66 message types such as `RetrievePreset`, `PresetJSONMessage` and `SavePresetAs`.
The table in [PROTOCOL.md](PROTOCOL.md) comes directly from these descriptors.

## 3. The framing

The schema describes the messages, not how they cross the USB cable. The symbols pointed to the
right functions, and disassembling them with `objdump` showed the framing:

- `FenderMessageLTEncoder::encodeMessage` just serialises the protobuf, refusing anything over
  4000 bytes.
- `LTMessageManager::attemptBeginMessageSend` writes `0x33` into the first byte of a 63-byte
  buffer when more chunks follow and `0x35` when the message fits in one, then the chunk's
  length, then the payload. `continueMessageSend` uses `0x34` for middle chunks.
- The constructor sets a 63-byte buffer, 61 bytes of payload per chunk (`0x3D`) and a heartbeat
  interval of `0x3B9ACA00` nanoseconds, one second.
- `FenderHIDSender::send` inserts a `0x00` report number before handing the report to HIDAPI.

At this point the open-source Python project [LtAmp.py](https://github.com/benderhq/LtAmp.py)
turned up. It had found the same framing by capturing USB traffic, which independently confirmed
everything above. Thanks to its authors.

## 4. The handshake

The first read-only experiment sent a heartbeat, a connection-status request and a firmware
request. The amp answered only the connection request, with `isConnected: false`. The official
app starts every session with `ModalStatusMessage{SYNC_BEGIN}`; after sending that, the amp
answered everything: firmware 2.1.4, product `mustang-lt-25`, and each preset as JSON. Two more
details came out of the same experiment:

- input reports carry an extra `0x00` byte in front of the tag;
- preset slots are numbered from 1 (asking for slot 0 returns slot 1).

Other limits came from small functions in the executable: `ToneDeviceLT::totalSlots` returns 60,
`maxPresetNameLength` returns 16, `allowedPresetNameChars` lists letters, digits and space, and
`LTMessageManager::enumerateDevices` contains a jump table of the product IDs the app accepts.

## 5. The amp and effect catalogue

The executable also contains the definitions of every amp model and effect as JSON strings:
parameter names, ranges, display ranges, list options and defaults. There are several copies,
and the symbols tell them apart: `fmic::dubs::lt::mustang::DUBS_Twin65Default` is the LT's own
definition of the '65 Twin amp, `fmic::dubs::gt::DUBS_Twin65Default` is a fuller definition
from Fender's larger GT amps that includes the settings the LT hides (cabinet, noise gate, sag,
tube bias), and `fmic::pp::lt::PP_MustangLT` says which units the LT offers in each position.
Fender's 100-preset factory library is there too, as `fmic::presets::lt::mustang::*`.

`ltctl setup` reads these by parsing the Mach-O file itself: it finds the x86_64 slice, reads
the symbol table, decodes the C++ names and follows each address to its string. It doesn't need
to run the app, so it works on Macs that can't.

The display values (the 1 to 10 numbers on the amp) are related to the stored values by curves
called tapers. Disassembling `StandardTaper`, `TaperExponential` and `TaperLogarithmic` showed
the formulas, `(k^x - 1)/(k - 1)` and its inverse, and a table called `taperData` holds the
constants for each named curve. [PROTOCOL.md](PROTOCOL.md) lists them. The conversions were
checked against values Fender Tone displays: a stored volume of -4.497767 dB on the '65 Twin
shows as 8.0.

## 6. Import and export

Fender Tone's "Export Preset" (`RootLevelComponent::savePresetToDisk`) writes the preset's JSON
to a `.preset` file, so ltctl uses the same format. The app has no import; its "Paste Preset"
and "Duplicate Preset to My Amp" send `SavePresetAs` with a preset's JSON and a slot number, so
ltctl uses exactly that to store presets. Renaming, swapping and clearing are built from the same
message, so every change to the amp is a single, well-understood write that can be verified by
reading the slot back.

## 7. Testing on a real amp

Everything was tested on a Mustang LT25 with firmware 2.1.4, carefully:

- Reads came first, and nothing else was tried until reading all 60 slots worked.
- Every write was first tried on an empty slot, read back, then undone by writing the slot's
  original contents back, and compared byte for byte with a copy taken beforehand.
- Nothing was ever written to a slot holding one of the owner's presets without being asked.

That testing found the amp's own behaviour, which ltctl now accounts for:

- the amp re-serialises the JSON it stores, dropping whitespace, so verification compares
  content rather than bytes;
- it never stores `"bypass": true` (effects are always saved switched on), so ltctl leaves an
  effect out by emptying its position instead, and warns about `bypass`;
- it sets `bypassType` itself, storing delay and reverb units as `"Pre"`;
- after an audition ends, it keeps playing the auditioned sound as an unsaved edit, so ltctl
  reloads the stored preset.

Speed was measured too. A preset of about 2 KB takes about 35 ms to arrive, because the amp is a
full-speed USB device sending one 64-byte report per millisecond. Keeping two requests in flight
reads all 60 slots in 2.25 s rather than 2.39 s; with eight in flight the amp drops requests.

## 8. Building ltctl

The first version was written in Swift alongside the Mac app. To run on Windows and Linux too,
the command-line tool was rewritten in TypeScript on [Bun](https://bun.com):

- USB access uses [node-hid](https://github.com/node-hid/node-hid)'s prebuilt Node-API addon,
  which contains HIDAPI for every platform. Bun can embed `.node` files in a compiled
  executable, but loading one from inside the executable took about 45 ms per run, so ltctl
  copies it to the cache folder the first time and loads it from there afterwards.
- The command-line design follows the [Command Line Interface Guidelines](https://clig.dev/)
  and current advice on making tools usable by AI agents: structured output, meaningful exit
  codes, no prompts, dry runs and self-description.
- The protocol code has byte-exact tests against the messages the amp accepted, and the
  command-line contract (JSON errors, exit codes, discovery) has end-to-end tests. Releases are
  built and the installers tested on Linux, macOS and Windows by GitHub Actions.

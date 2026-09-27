# Changelog

## 1.0.0

The first public release.

- Read, list, show and compare every preset on a Fender Mustang LT over USB, with knob values
  as the amp displays them, including settings hidden from the amp's panel.
- Create and edit presets with `key=value` settings in display units (`ltctl new`, `ltctl set`),
  or from JSON tone specs.
- Store, rename, swap and clear presets, with automatic backups and read-back verification.
- Back up and restore the whole amp (`pull`, `backup`, `restore`), in the same `.preset` format
  as Fender Tone LT Desktop.
- Audition presets without saving them, and switch the amp between presets.
- Fender's 100-preset factory library, usable as `factory:<name>`.
- `ltctl setup` reads the amp and effect catalogue from your own copy of Fender Tone LT Desktop,
  its installer `.dmg` or a `catalog.json`.
- Agent-friendly: `--json` everywhere, meaningful exit codes, no prompts, `--dry-run`,
  `ltctl guide`, `ltctl commands --json` and `ltctl markdown`.
- `ltctl doctor` checks the catalogue, USB access and the amp.
- Single-file executables for macOS (Apple silicon and Intel), Linux (x64 and arm64) and Windows
  (x64 and arm64), with one-line installers.

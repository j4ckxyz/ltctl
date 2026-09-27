#!/bin/zsh
# Builds build/ToneLT.app (native Apple silicon) with the ltctl CLI (cli/, Bun) inside it.
#
# The amp and effect catalogue and factory presets are read from your own copy of
# Fender Tone LT Desktop (installed app or installer .dmg); nothing from Fender is
# stored in this repository. Pass the path explicitly or let the script look for it:
#   scripts/build-app.sh ["/path/to/Fender Tone LT Desktop.app" | "/path/to/Fender Tone App.dmg"]
set -euo pipefail

cd "${0:A:h}/.."
ROOT=$PWD
BUILD="$ROOT/build"
APP="$BUILD/ToneLT.app"
mkdir -p "$BUILD"

# 1. Catalogue ---------------------------------------------------------------
# ltctl reads it out of Fender Tone LT Desktop (see `ltctl setup --help`).
CATALOG="$BUILD/catalog.json"
SOURCE="${1:-${FENDER_TONE_SOURCE:-}}"
if command -v bun >/dev/null; then
  (cd cli && bun install --frozen-lockfile >/dev/null)
  if [[ -n "$SOURCE" ]]; then
    (cd cli && bun src/main.ts setup "${SOURCE:A}" -o "$CATALOG")
  elif [[ ! -f "$CATALOG" ]]; then
    (cd cli && bun src/main.ts setup -o "$CATALOG") || echo "warning: building without the catalogue" >&2
  else
    echo "Using previously extracted $CATALOG"
  fi
fi

# 2. Compile ----------------------------------------------------------------
swift build -c release --product ToneLT
BIN="$(swift build -c release --show-bin-path)"

# The CLI is TypeScript on Bun; compile a standalone binary for this Mac.
LTCTL=""
if command -v bun >/dev/null; then
  (cd cli && bun run scripts/build.ts --host)
  LTCTL="$ROOT/cli/dist/ltctl-macos-$(uname -m | sed 's/x86_64/x64/')"
else
  echo "warning: bun not found; building ToneLT.app without ltctl (https://bun.com)" >&2
fi

# 3. Bundle -----------------------------------------------------------------
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/ToneLT" "$APP/Contents/MacOS/"
[[ -n "$LTCTL" ]] && cp "$LTCTL" "$APP/Contents/MacOS/ltctl"
[[ -f "$CATALOG" ]] && cp "$CATALOG" "$APP/Contents/Resources/catalog.json"
cp "$ROOT/Resources/Info.plist" "$APP/Contents/Info.plist"

ICONSET="$BUILD/AppIcon.iconset"
if [[ ! -f "$BUILD/AppIcon.icns" ]]; then
  rm -rf "$ICONSET" && mkdir -p "$ICONSET"
  swift "$ROOT/tools/make_icon.swift" "$BUILD/icon-1024.png"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$BUILD/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$BUILD/icon-1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$BUILD/AppIcon.icns"
fi
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature so macOS runs it locally (no hardened runtime, no sandbox: USB access
# to the amp's vendor HID interface needs neither entitlements nor permissions prompts).
[[ -n "$LTCTL" ]] && codesign --force --sign - "$APP/Contents/MacOS/ltctl"
codesign --force --sign - "$APP"

echo
echo "Built $APP"
echo "  Install:   cp -R \"$APP\" /Applications/"
echo "  CLI:       ln -sf \"/Applications/ToneLT.app/Contents/MacOS/ltctl\" /usr/local/bin/ltctl"

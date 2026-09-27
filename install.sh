#!/bin/sh
# ltctl installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/j4ckxyz/ltctl/main/install.sh | sh
#
# Installs the ltctl binary system-wide (/usr/local/bin by default; asks for your password
# via sudo if that folder isn't writable). On Linux it also adds a udev rule so ltctl can
# open the amp without root.
#
# Options, as environment variables or arguments after `sh -s --`:
#   LTCTL_VERSION=v1.0.0        install a specific release (default: latest)
#   LTCTL_INSTALL_DIR=~/bin     install somewhere else (no sudo needed if writable)
#   LTCTL_NO_UDEV=1             skip the Linux udev rule
#   LTCTL_BASE_URL=https://…    download from a mirror instead of GitHub Releases
#   --uninstall                 remove ltctl and the udev rule
set -eu

REPO="j4ckxyz/ltctl"
INSTALL_DIR="${LTCTL_INSTALL_DIR:-/usr/local/bin}"
VERSION="${LTCTL_VERSION:-latest}"
UDEV_RULE="/etc/udev/rules.d/70-fender-lt.rules"

say() { printf '%s\n' "$*"; }
fail() { printf 'ltctl install: %s\n' "$*" >&2; exit 1; }

# Runs a command with sudo only when needed.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else fail "need root to run: $* (install sudo, or set LTCTL_INSTALL_DIR to a folder you own)"
  fi
}

writable() {
  [ -d "$1" ] && [ -w "$1" ] || { [ ! -e "$1" ] && [ -w "$(dirname "$1")" ]; }
}

if [ "${1:-}" = "--uninstall" ]; then
  target="$INSTALL_DIR/ltctl"
  if [ -e "$target" ]; then
    if writable "$INSTALL_DIR"; then rm -f "$target"; else as_root rm -f "$target"; fi
    say "Removed $target"
  else
    say "ltctl is not installed in $INSTALL_DIR"
  fi
  if [ -e "$UDEV_RULE" ]; then as_root rm -f "$UDEV_RULE"; say "Removed $UDEV_RULE"; fi
  say "Your presets, backups and catalogue were left in place (see \`ltctl doctor\` for where)."
  exit 0
fi

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) fail "unsupported system $(uname -s); on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported processor $(uname -m)" ;;
esac
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  fail "musl-based Linux (e.g. Alpine) isn't supported yet; use a glibc distribution"
fi

asset="ltctl-$os-$arch.tar.gz"
if [ -n "${LTCTL_BASE_URL:-}" ]; then
  base="$LTCTL_BASE_URL"
elif [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "curl or wget is required"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $asset ($VERSION)…"
fetch "$base/$asset" "$tmp/$asset" || fail "could not download $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download the checksums"

expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$expected" ] || fail "$asset is missing from SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"

tar -xzf "$tmp/$asset" -C "$tmp"
[ -f "$tmp/ltctl" ] || fail "the archive doesn't contain ltctl"
chmod 0755 "$tmp/ltctl"
if [ "$os" = macos ]; then
  xattr -d com.apple.quarantine "$tmp/ltctl" 2>/dev/null || true
fi

say "Installing to $INSTALL_DIR/ltctl…"
if writable "$INSTALL_DIR"; then
  mkdir -p "$INSTALL_DIR"
  mv "$tmp/ltctl" "$INSTALL_DIR/ltctl"
else
  as_root mkdir -p "$INSTALL_DIR"
  as_root mv "$tmp/ltctl" "$INSTALL_DIR/ltctl"
  as_root chmod 0755 "$INSTALL_DIR/ltctl"
fi

if [ "$os" = linux ] && [ -z "${LTCTL_NO_UDEV:-}" ] && [ ! -e "$UDEV_RULE" ]; then
  say "Adding a udev rule so ltctl can open the amp without root…"
  printf '%s\n' '# Fender Mustang LT amplifiers (vendor 0x1ed8): allow the logged-in user to use the HID interface.' \
    'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1ed8", TAG+="uaccess", MODE="0660"' > "$tmp/70-fender-lt.rules"
  as_root mv "$tmp/70-fender-lt.rules" "$UDEV_RULE"
  as_root udevadm control --reload-rules 2>/dev/null || true
  as_root udevadm trigger 2>/dev/null || true
  say "If the amp was already plugged in, unplug it and plug it back in."
fi

say ""
say "Installed $("$INSTALL_DIR/ltctl" --version) to $INSTALL_DIR/ltctl"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) say "Note: $INSTALL_DIR is not on your PATH; add it, or run $INSTALL_DIR/ltctl." ;;
esac
say ""
say "Next:"
say "  ltctl setup     install the amp and effect catalogue (needs Fender Tone LT Desktop on a Mac)"
say "  ltctl doctor    check that everything works"
say "  ltctl list      list your amp's presets"

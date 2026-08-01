#!/usr/bin/env bash
# Install the CC1 integration: Bitwig control script, ControlCenter plugin, and the
# profile that binds the two together.
#
#   ./install.sh          copy files -- survives this repo being moved or deleted,
#                         but goes stale as soon as you edit anything here
#   ./install.sh --link   symlink them -- edits are live, but the repo is pinned
#                         to its current path
#
# Restarts ControlCenter, which has to be stopped while we swap the plugin and rewrite
# its prefs (it flushes its own cache over them on quit).
set -euo pipefail

MODE=copy
[ "${1:-}" = "--link" ] && MODE=link

REPO="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="com.thomas.bitwig.ypPlugin"
CC_PLUGINS="$HOME/Library/Application Support/yamaha/ControlCenter/Plugins"
BW_SCRIPTS="$HOME/Documents/Bitwig Studio/Controller Scripts/Yamaha"
CC_APP="/Applications/ControlCenter.app"

# node_modules is gitignored (prebuilt native binary), so a fresh clone has none. The
# lockfile is committed, so this resolves to the same version every time.
npm ci --prefix "$REPO/cc-plugin/$PLUGIN"

# Only ever Yamaha's ControlCenter -- never Apple's in /System/Library/CoreServices.
pkill -f "^$CC_APP/Contents/MacOS/ControlCenter" || true
sleep 2

place() { # $1 = source path, $2 = destination directory
  mkdir -p "$2"
  rm -rf "${2:?}/$(basename "$1")"
  if [ "$MODE" = link ]; then ln -s "$1" "$2/"; else cp -R "$1" "$2/"; fi
}

place "$REPO/cc-plugin/$PLUGIN" "$CC_PLUGINS"
place "$REPO/CC1.control.js" "$BW_SCRIPTS"

if [ "$MODE" = copy ]; then
  # A copy carries no clue where it came from, and a stale one keeps working normally --
  # so leave a breadcrumb to diff against the repo. ControlCenter ignores stray files.
  {
    echo "$REPO"
    # --dirty matters: without it a copy taken from an edited tree claims to be the last
    # commit. git rather than jj, since git is the one we can assume is installed.
    echo "commit $(git -C "$REPO" describe --always --dirty --abbrev=12 2>/dev/null || echo unknown)"
    echo "copied $(date '+%Y-%m-%d %H:%M')"
  } > "$CC_PLUGINS/$PLUGIN/INSTALLED-FROM.txt"
fi

python3 "$REPO/cc-plugin/install-profile.py"
open -a "$CC_APP"

cat <<EOF

Installed by $MODE.

Still to do by hand:
  - ControlCenter: pick the Pro Tools -> Bitwig profile (the knobs are dead without it).
  - Bitwig: set the CC1's two MIDI inputs to "CC Virtual MIDI Driver Port1" and
    "CC1 Knobs". If you only see one input, restart Bitwig -- port counts are read
    when it scans scripts at launch.
EOF

#!/usr/bin/env bash
# Checks one signed, notarized chatmany dmg as a Mac sees a file downloaded
# with a browser, and copies the app out of it for the smoke test.
#
#   scripts/verify-mac-release.sh <dmg> <arm64|x64> <app folder> <report folder>
#
# It puts a quarantine mark on the dmg (as a browser does), then checks the dmg
# with Gatekeeper (spctl), its stapled notarization ticket (stapler) and
# codesign; mounts it, copies chatmany.app out to <app folder> (the copy keeps
# the quarantine mark, as a download does), and checks
# the app the same way, plus its bundle id, version, architecture,
# entitlements and app token (never shown).
#
# Results: <report folder>/release-checks.md (also added to
# $GITHUB_STEP_SUMMARY) and release-checks.log (the full tool output).
# Exit 0 only when every check passed.
set -uo pipefail

DMG="${1:-}"
ARCH="${2:-}"
APP_DIR="${3:-}"
REPORT_DIR="${4:-}"
TEAM="R5R3ZS54LV"
BUNDLE_ID="com.publikhq.chatmany"
HERE="$(cd "$(dirname "$0")" && pwd)"
ENTITLEMENTS="$HERE/../build-resources/entitlements.mac.plist"

case "$ARCH" in
  arm64) MACHO=arm64 ;;
  x64) MACHO=x86_64 ;;
  *) echo "usage: $0 <dmg> <arm64|x64> <app folder> <report folder>"; exit 2 ;;
esac
if [ ! -f "$DMG" ] || [ -z "$APP_DIR" ] || [ -z "$REPORT_DIR" ]; then
  echo "usage: $0 <dmg> <arm64|x64> <app folder> <report folder>"
  exit 2
fi
mkdir -p "$APP_DIR" "$REPORT_DIR"
REPORT="$REPORT_DIR/release-checks.md"
LOG="$REPORT_DIR/release-checks.log"
: >"$LOG"
NAME="$(basename "$DMG")"
VERSION="$(printf '%s' "$NAME" | sed -E 's/^chatmany-(.+)-mac-(arm64|x64)\.dmg$/\1/')"
SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
APP="$APP_DIR/chatmany.app"
EXE="$APP/Contents/MacOS/chatmany"

fails=0
rows=()
# record <exit status> <check> <detail>
record() {
  local detail="${3:-}"
  detail="${detail//$'\n'/ }"
  detail="${detail//|/\\|}"
  if [ "$1" = 0 ]; then
    rows+=("| $2 | pass | $detail |")
    echo "PASS $2${detail:+: $detail}"
  else
    rows+=("| $2 | **FAIL** | $detail |")
    echo "FAIL $2${detail:+: $detail}"
    fails=$((fails + 1))
  fi
}
# cap <command...>: runs it, keeps its output in $CAP and in the log, returns its status.
cap() {
  CAP="$("$@" 2>&1)"
  local status=$?
  { printf '$ %s\n%s\n(exit %s)\n\n' "$*" "$CAP" "$status"; } >>"$LOG"
  return $status
}
finish() {
  {
    echo "### Signed release checks (mac-$ARCH)"
    echo
    echo "File \`$NAME\`, sha256 \`$SHA\`."
    echo
    if [ "$fails" = 0 ]; then echo "All ${#rows[@]} checks passed."; else echo "$fails of ${#rows[@]} checks FAILED."; fi
    echo
    echo "| Check | Result | Detail |"
    echo "|---|---|---|"
    printf '%s\n' "${rows[@]}"
    echo
  } >"$REPORT"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$REPORT" >>"$GITHUB_STEP_SUMMARY"; fi
  exit $((fails > 0 ? 1 : 0))
}

# ---------- the dmg, quarantined as after a browser download ----------
QUARANTINE="0081;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)"
xattr -w com.apple.quarantine "$QUARANTINE" "$DMG"
cap xattr -p com.apple.quarantine "$DMG"
record $? "the dmg carries a quarantine mark, as after a browser download" "$CAP"

cap codesign -dvv "$DMG"
printf '%s\n' "$CAP" | grep -q "^TeamIdentifier=$TEAM\$" &&
  printf '%s\n' "$CAP" | grep -Eq "^Authority=Developer ID Application: .*\($TEAM\)\$"
record $? "the dmg is signed with Developer ID, team $TEAM" "$(printf '%s\n' "$CAP" | grep -m1 '^Authority=')"

cap spctl --assess --type open --context context:primary-signature -vv "$DMG" &&
  printf '%s\n' "$CAP" | grep -q "source=Notarized Developer ID"
record $? "Gatekeeper accepts the quarantined dmg (spctl --assess --type open)" "$(printf '%s\n' "$CAP" | grep -m1 'source=')"

cap xcrun stapler validate "$DMG"
record $? "the notarization ticket is stapled to the dmg (stapler validate)" "$(printf '%s\n' "$CAP" | tail -1)"

# ---------- mount it and copy the app out ----------
MNT="$(mktemp -d "${RUNNER_TEMP:-/tmp}/chatmany-mnt.XXXXXX")"
cap hdiutil attach "$DMG" -nobrowse -readonly -noautoopen -mountpoint "$MNT"
record $? "the quarantined dmg mounts" ""
if [ ! -d "$MNT/chatmany.app" ]; then
  record 1 "the dmg holds chatmany.app" "$(ls "$MNT" 2>&1)"
  hdiutil detach "$MNT" -quiet 2>/dev/null
  finish
fi
rm -rf "$APP"
cap ditto "$MNT/chatmany.app" "$APP"
record $? "chatmany.app copies out of the dmg (ditto keeps its extended attributes)" ""
hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet
if [ ! -x "$EXE" ]; then
  record 1 "the copied app has its executable" "$EXE"
  finish
fi

if xattr -p com.apple.quarantine "$EXE" >/dev/null 2>&1; then
  source_of_mark="inherited from the quarantined dmg"
else
  xattr -r -w com.apple.quarantine "$QUARANTINE" "$APP"
  source_of_mark="set by this script: the mount did not pass the mark on"
fi
xattr -p com.apple.quarantine "$EXE" >/dev/null 2>&1
record $? "the copied app keeps the quarantine mark of a download" "$source_of_mark"

# ---------- the app ----------
id="$(plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist" 2>&1)"
version="$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist" 2>&1)"
[ "$id" = "$BUNDLE_ID" ] && [ "$version" = "$VERSION" ]
record $? "bundle id $BUNDLE_ID, version $VERSION" "$id $version"

archs="$(lipo -archs "$EXE" 2>&1)"
[ "$archs" = "$MACHO" ]
record $? "the executable is $MACHO only" "$archs (this runner: $(uname -m))"

cap codesign --verify --deep --strict --verbose=2 "$APP"
record $? "codesign --verify --deep --strict passes (every helper and framework)" "$(printf '%s\n' "$CAP" | grep -c 'validated') nested parts validated"

cap codesign -dvv "$APP"
printf '%s\n' "$CAP" | grep -q "^TeamIdentifier=$TEAM\$" &&
  printf '%s\n' "$CAP" | grep -Eq "^Authority=Developer ID Application: .*\($TEAM\)\$" &&
  printf '%s\n' "$CAP" | grep -Eq "flags=0x[0-9a-f]+\([^)]*runtime"
record $? "the app is signed with Developer ID, team $TEAM, hardened runtime" "$(printf '%s\n' "$CAP" | grep -m1 '^CodeDirectory' | grep -Eo 'flags=[^ ]+')"

ENT_APP="$REPORT_DIR/entitlements-app.plist"
codesign -d --entitlements - --xml "$APP" >"$ENT_APP" 2>>"$LOG"
node -e '
  const { execFileSync } = require("node:child_process");
  const read = (f) => JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", f], { encoding: "utf8" }));
  const flat = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  const [app, repo] = [read(process.argv[1]), read(process.argv[2])];
  console.log(Object.keys(app).sort().join(", "));
  process.exit(flat(app) === flat(repo) ? 0 : 1);
' "$ENT_APP" "$ENTITLEMENTS" >"$REPORT_DIR/entitlements.txt" 2>&1
record $? "the app's entitlements are exactly build-resources/entitlements.mac.plist" "$(cat "$REPORT_DIR/entitlements.txt")"

cap spctl --assess --type execute -vv "$APP" &&
  printf '%s\n' "$CAP" | grep -q "source=Notarized Developer ID"
record $? "Gatekeeper accepts the quarantined app (spctl --assess --type execute)" "$(printf '%s\n' "$CAP" | grep -m1 'source=')"

cap xcrun stapler validate "$APP"
record $? "the notarization ticket is stapled to the app (stapler validate)" "$(printf '%s\n' "$CAP" | tail -1)"

cap node "$HERE/has-app-token.mjs" "$APP/Contents/Resources/app.asar"
record $? "the app carries its publik app token (value not shown)" "$CAP"

finish

# Where the installed 10db and its data live, where install-app.sh and rollback-app.sh keep the
# previous app, and the lock, running check and app handling they share. Sourced by both, never
# run; the sourcing script sets `script_name` first.
#
# TENDB_INSTALL_APPLICATIONS_DIR, TENDB_INSTALL_DATA_DIR, TENDB_INSTALL_LSREGISTER and
# TENDB_INSTALL_STAMP move the places, replace Launch Services and fix the clock, for the repo
# tests. TENDB_DATA_DIR is deliberately not read: the app opened from Finder never sees this
# shell's environment, so a TENDB_DATA_DIR here (the dev data in .dev/data, say) is not the app's.
# Written for macOS's /bin/bash 3.2: no mapfile, and no expansion of an empty array under set -u.

apps_dir="${TENDB_INSTALL_APPLICATIONS_DIR:-/Applications}"
data_dir="${TENDB_INSTALL_DATA_DIR:-$HOME/Library/Application Support/10db}"
app_path="$apps_dir/10db.app"
# The daemon's database file (apps/daemon/src/daemon/start.ts).
db_file="$data_dir/10db.sqlite"
# The app an install replaces is kept here as one zip, not renamed in Applications: Launch Services
# follows a renamed bundle, so the Dock and Spotlight would go on opening the old copy.
previous_dir="$(dirname "$data_dir")/10db-previous"
lock_dir="$apps_dir/.10db-install.lock"
locked=0
lsregister="${TENDB_INSTALL_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"

# An executable under Contents/MacOS of a 10db.app bundle, wherever it is, or of a copy named
# 10db.app.<something>: the window (tendb-desktop) and the daemon (tendb-node, running daemon.mjs
# or srt.mjs). Each of them holds the database.
app_process_pattern='/10db\.app(\.[^/]*)?/Contents/MacOS/'

fail() {
  echo "$script_name: $*" >&2
  exit 1
}

# UTC to the second, so names sort in time order across time zones and daylight saving. An install
# stamps the database backup and the zip of the app it replaces with the same value, which is how a
# rollback finds the backup that goes with an app.
new_stamp() {
  if [ -n "${TENDB_INSTALL_STAMP:-}" ]; then
    echo "$TENDB_INSTALL_STAMP"
  else
    date -u +%Y%m%dT%H%M%SZ
  fi
}
is_stamp() { [[ "$1" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; }
if [ -n "${TENDB_INSTALL_STAMP:-}" ] && ! is_stamp "$TENDB_INSTALL_STAMP"; then
  fail "TENDB_INSTALL_STAMP is '$TENDB_INSTALL_STAMP', not a UTC stamp such as 20261029T101500Z"
fi

# Beside the data directory, as the backups made by hand are: ~/Library/Application Support/10db-backup-<stamp>.
backup_file_for() { echo "$(dirname "$data_dir")/$(basename "$data_dir")-backup-$1/10db.sqlite"; }
previous_zip_for() { echo "$previous_dir/10db-$1.zip"; }

refuse_while_running() {
  local pids status=0
  pids="$(pgrep -f "$app_process_pattern")" || status=$?
  case "$status" in
    0) fail "10db is running (process $(echo $pids)). Quit it with ⌘Q, then run this again. This script never quits 10db for you." ;;
    1) ;;
    *) fail "pgrep could not check whether 10db is running (exit $status)" ;;
  esac
}

# One install or rollback at a time: two at once would replace each other's apps.
take_lock() {
  if mkdir "$lock_dir" 2> /dev/null; then
    locked=1
    return 0
  fi
  [ -e "$lock_dir" ] || fail "could not create $lock_dir; can you write to $apps_dir?"
  fail "another make install-app or make rollback-app holds $lock_dir. If neither is running, one was interrupted: look with ls -d \"$app_path\"* \"$previous_dir\"/*, remove the lock with rmdir \"$lock_dir\", then run make rollback-app if 10db.app is missing or broken."
}
release_lock() {
  if [ "$locked" -eq 1 ]; then
    rmdir "$lock_dir" 2> /dev/null || echo "$script_name: could not remove $lock_dir; remove it with rmdir" >&2
    locked=0
  fi
}

# Zips the installed app to $1 and tests the zip; only a whole zip that holds the app's Info.plist
# gets the name. Returns 1, leaving no file, when either step fails.
zip_app() {
  local zip="$1" partial="$1.partial" listing
  mkdir -p "$previous_dir" || return 1
  if ditto -c -k --keepParent "$app_path" "$partial" && unzip -tq "$partial" > /dev/null 2>&1 \
    && listing="$(unzip -Z1 "$partial")" && grep -qx '10db.app/Contents/Info.plist' <<< "$listing" \
    && mv "$partial" "$zip"; then
    return 0
  fi
  rm -f "$partial"
  return 1
}

# Unpacks the one app bundle in a zip into a new folder beside the kept zips and prints its path.
# A zip made by hand may name its bundle otherwise; it still holds exactly one, with an Info.plist.
unpack_app() {
  local zip="$1" stage entry found="" count=0
  unzip -tq "$zip" > /dev/null 2>&1 || {
    echo "$script_name: $zip does not test as a whole zip" >&2
    return 1
  }
  stage="$(mktemp -d "$previous_dir/.unpack.XXXXXX")" || return 1
  if ! ditto -x -k "$zip" "$stage"; then
    rm -rf "$stage"
    return 1
  fi
  for entry in "$stage"/*; do
    [ "$(basename "$entry")" != __MACOSX ] || continue
    count=$((count + 1))
    found="$entry"
  done
  if [ "$count" -ne 1 ] || [ ! -f "$found/Contents/Info.plist" ]; then
    echo "$script_name: $zip does not hold one app with a Contents/Info.plist" >&2
    rm -rf "$stage"
    return 1
  fi
  echo "$found"
}

# Points the Dock, Launchpad and Spotlight at the app now in place.
register_app() {
  "$lsregister" -f -R "$app_path" \
    || echo "$script_name: lsregister could not register $app_path; if the Dock opens an old copy, run: \"$lsregister\" -f -R \"$app_path\"" >&2
}

# The app is unsigned, so Gatekeeper refuses any copy that carries com.apple.quarantine. This clears
# it on the installed app alone, without following symlinks out of the bundle.
clear_quarantine() {
  local attributes
  xattr -r -s -d com.apple.quarantine "$app_path"
  attributes="$(xattr -r -s -l "$app_path")"
  case "$attributes" in *com.apple.quarantine*) fail "com.apple.quarantine is still set inside $app_path" ;; esac
}

# Deletes every kept zip but $1. Called only once $1 is tested and the app swap has finished.
keep_only_zip() {
  local zip
  for zip in "$previous_dir"/10db-*.zip; do
    [ -e "$zip" ] || continue
    [ "$zip" = "$1" ] || rm -f "$zip"
  done
}

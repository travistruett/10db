# Where the installed 10db and its data live, how install-app.sh and rollback-app.sh name what they
# keep, and the lock and running check they share. Sourced by both, never run; the sourcing script
# sets `script_name` first.
#
# TENDB_INSTALL_APPLICATIONS_DIR, TENDB_INSTALL_DATA_DIR and TENDB_INSTALL_STAMP move both places
# and fix the clock, for the repo tests. TENDB_DATA_DIR is deliberately not read: the app opened
# from Finder never sees this shell's environment, so a TENDB_DATA_DIR here (the dev data in
# .dev/data, say) is not the app's data.
# Written for macOS's /bin/bash 3.2: no mapfile, and no expansion of an empty array under set -u.

apps_dir="${TENDB_INSTALL_APPLICATIONS_DIR:-/Applications}"
data_dir="${TENDB_INSTALL_DATA_DIR:-$HOME/Library/Application Support/10db}"
app_path="$apps_dir/10db.app"
# The daemon's database file (apps/daemon/src/daemon/start.ts).
db_file="$data_dir/10db.sqlite"
lock_dir="$apps_dir/.10db-install.lock"
locked=0

# An executable under Contents/MacOS of a 10db.app bundle, wherever it is, or of a saved
# 10db.app.prev-* or 10db.app.rolled-back-* beside it: the window (tendb-desktop) and the daemon
# (tendb-node, running daemon.mjs or srt.mjs). Each of them holds the database.
app_process_pattern='/10db\.app(\.[^/]*)?/Contents/MacOS/'

fail() {
  echo "$script_name: $*" >&2
  exit 1
}

# UTC to the second, so names sort in time order across time zones and daylight saving. An install
# stamps the database backup and the app it moves aside with the same value, which is how a
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

refuse_while_running() {
  local pids status=0
  pids="$(pgrep -f "$app_process_pattern")" || status=$?
  case "$status" in
    0) fail "10db is running (process $(echo $pids)). Quit it with ⌘Q, then run this again. This script never quits 10db for you." ;;
    1) ;;
    *) fail "pgrep could not check whether 10db is running (exit $status)" ;;
  esac
}

# One install or rollback at a time: two at once would move each other's apps.
take_lock() {
  if mkdir "$lock_dir" 2> /dev/null; then
    locked=1
    return 0
  fi
  [ -e "$lock_dir" ] || fail "could not create $lock_dir; can you write to $apps_dir?"
  fail "another make install-app or make rollback-app holds $lock_dir. If neither is running, one was interrupted: look with ls -d \"$app_path\"*, remove the lock with rmdir \"$lock_dir\", then run make rollback-app if 10db.app is missing or broken."
}
release_lock() {
  if [ "$locked" -eq 1 ]; then
    rmdir "$lock_dir" 2> /dev/null || echo "$script_name: could not remove $lock_dir; remove it with rmdir" >&2
    locked=0
  fi
}

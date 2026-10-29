# Where the installed 10db and its data live, and how install-app.sh and rollback-app.sh name what
# they keep. Sourced by both, never run; the sourcing script sets `script_name` first.
#
# TENDB_INSTALL_APPLICATIONS_DIR and TENDB_INSTALL_DATA_DIR move both places, for the repo tests.
# TENDB_DATA_DIR is deliberately not read: the app opened from Finder never sees this shell's
# environment, so a TENDB_DATA_DIR here (the dev data in .dev/data, say) is not the app's data.
# Written for macOS's /bin/bash 3.2: no mapfile, and no expansion of an empty array under set -u.

apps_dir="${TENDB_INSTALL_APPLICATIONS_DIR:-/Applications}"
data_dir="${TENDB_INSTALL_DATA_DIR:-$HOME/Library/Application Support/10db}"
app_path="$apps_dir/10db.app"
# The daemon's database file (apps/daemon/src/daemon/start.ts).
db_file="$data_dir/10db.sqlite"

fail() {
  echo "$script_name: $*" >&2
  exit 1
}

# Local time to the second. An install stamps the database backup and the app it moves aside with
# the same value, which is how a rollback finds the backup that goes with an app.
new_stamp() { date +%Y%m%d-%H%M%S; }
is_stamp() { [[ "$1" =~ ^[0-9]{8}-[0-9]{6}$ ]]; }

# Beside the data directory, as the backups made by hand are: ~/Library/Application Support/10db-backup-<stamp>.
backup_file_for() { echo "$(dirname "$data_dir")/$(basename "$data_dir")-backup-$1/10db.sqlite"; }

# Any process run from a 10db.app bundle (the window, tendb-desktop, and its daemon, tendb-node),
# a saved 10db.app.prev-* included: each of them holds the database.
refuse_while_running() {
  local pids status=0
  pids="$(pgrep -f '/10db\.app[^/]*/Contents/MacOS/')" || status=$?
  case "$status" in
    0) fail "10db is running (process $(echo $pids)). Quit it with ⌘Q, then run this again. This script never quits 10db for you." ;;
    1) ;;
    *) fail "pgrep could not check whether 10db is running (exit $status)" ;;
  esac
}

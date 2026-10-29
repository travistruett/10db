#!/usr/bin/env bash
# Puts back the app install-app.sh replaced: it unpacks the newest kept zip,
# 10db-previous/10db-<stamp>.zip beside the data directory, into /Applications/10db.app. The app it
# replaces becomes the kept zip in turn, so a second run toggles back. It registers the restored
# app with Launch Services. It never touches the database; it prints the commands that back up the
# current one and restore the backup taken with that install. It refuses while 10db runs.
# Exit 0: restored. Exit 1: refused or failed; the current app is put back, and when it can't be,
# the last message says where it is. Exit 2: bad argument.
set -euo pipefail

script_name=rollback-app.sh
# shellcheck source=scripts/release/installed-app.sh
. "$(cd "$(dirname "$0")" && pwd)/installed-app.sh"

[ "$#" -eq 0 ] || {
  echo "usage: rollback-app.sh (no arguments)" >&2
  exit 2
}

refuse_while_running

stage=""
current_zip=""
zip_done=0
removing=0
restoring=0
# Never aborts part way, and a Ctrl-C while it runs is ignored. The current app is unpacked from its
# zip only into an empty place. Once the kept app has been moved in, there is nothing to put back.
cleanup() {
  trap '' INT TERM HUP
  set +e
  local finished=0 bundle=""
  if [ "$restoring" -eq 1 ] && [ -e "$app_path" ]; then finished=1; fi
  if [ -n "$current_zip" ]; then rm -f "$current_zip.partial"; fi
  if [ "$finished" -eq 0 ] && [ "$removing" -eq 1 ]; then
    rm -rf "$app_path" 2> /dev/null
    if [ ! -e "$app_path" ] && bundle="$(unpack_app "$current_zip")" && mv "$bundle" "$app_path"; then
      rmdir "$(dirname "$bundle")" 2> /dev/null
      rm -f "$current_zip"
      echo "$script_name: put the current app back at $app_path" >&2
    else
      echo "$script_name: could not put the current app back. It is kept in $current_zip; once $app_path is out of the way, run: ditto -x -k \"$current_zip\" \"$apps_dir\"" >&2
    fi
  elif [ "$finished" -eq 0 ] && [ "$zip_done" -eq 1 ]; then
    rm -f "$current_zip"
  fi
  if [ -n "$stage" ]; then rm -rf "$stage"; fi
  release_lock
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

take_lock

shopt -s nullglob
zip=""
for path in "$previous_dir"/10db-*.zip; do
  candidate="${path##*/10db-}"
  candidate="${candidate%.zip}"
  # Stamps sort as text in time order.
  if is_stamp "$candidate" && { [ -z "$zip" ] || [[ "$path" > "$zip" ]]; }; then zip="$path"; fi
done
[ -n "$zip" ] || fail "no previous app is kept in $previous_dir (a zip named 10db-<UTC stamp>.zip), so nothing was moved"
stamp="${zip##*/10db-}"
stamp="${stamp%.zip}"

bundle="$(unpack_app "$zip")" || fail "could not unpack the app in $zip, so nothing was moved"
stage="$(dirname "$bundle")"

if [ -e "$app_path" ]; then
  current_zip="$(previous_zip_for "$(new_stamp)")"
  [ ! -e "$current_zip" ] || fail "$current_zip already exists, so nothing was moved"
  zip_app "$current_zip" || fail "could not zip $app_path to $current_zip and test the zip, so nothing was moved"
  zip_done=1
  removing=1
  rm -rf "$app_path"
fi
restoring=1
mv "$bundle" "$app_path"
clear_quarantine
register_app
if [ -n "$current_zip" ]; then keep_only_zip "$current_zip"; fi

echo "Restored $app_path from $zip."
if [ -n "$current_zip" ]; then echo "  The app it replaced is kept in $current_zip; run make rollback-app again to go back to it."; fi
backup="$(backup_file_for "$stamp")"
if [ -f "$backup" ]; then
  safety="$(dirname "$(backup_file_for "$(new_stamp)")")"
  echo "The database backup taken by that install is $backup."
  echo "10db has written to its database since, and a newer build may have migrated it, which the"
  echo "restored app can't read. To go back to the backup, keep 10db quit and run these. The first two"
  echo "keep a copy of the database as it is now, so the restore can be undone; the last replaces it:"
  echo "  mkdir \"$safety\""
  echo "  sqlite3 \"$db_file\" \".backup '$safety/10db.sqlite'\""
  echo "  sqlite3 \"$db_file\" \".restore '$backup'\""
else
  echo "No database backup matches $stamp (expected $backup), so the database stays as it is."
fi
echo "Then open 10db."

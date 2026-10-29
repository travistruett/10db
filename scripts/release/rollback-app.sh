#!/usr/bin/env bash
# Puts back the app install-app.sh moved aside: the newest /Applications/10db.app.prev-<stamp>.
# Run again, it steps one saved app further back. The app it replaces is kept as
# 10db.app.rolled-back-<stamp>. It never touches the database; it prints the commands that back up
# the current one and restore the backup taken with that install. It refuses while 10db runs.
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

replaced=""
restored=0
# Never aborts part way. The current app goes back only into an empty place.
cleanup() {
  set +e
  if [ "$restored" -eq 0 ] && [ -n "$replaced" ] && [ -e "$replaced" ]; then
    if [ ! -e "$app_path" ] && mv "$replaced" "$app_path"; then
      echo "$script_name: put the current app back at $app_path" >&2
    else
      echo "$script_name: could not put the current app back. It is at $replaced; once $app_path is out of the way, run: mv \"$replaced\" \"$app_path\"" >&2
    fi
  fi
  release_lock
}
trap cleanup EXIT
trap 'exit 130' INT TERM

take_lock

shopt -s nullglob
newest=""
others=""
for path in "$app_path".prev-*; do
  stamp="${path##*.prev-}"
  if is_stamp "$stamp"; then
    # Stamps sort as text in time order.
    if [ -z "$newest" ] || [[ "$stamp" > "${newest##*.prev-}" ]]; then newest="$path"; fi
  else
    others="$others $(basename "$path")"
  fi
done
if [ -z "$newest" ]; then
  if [ -n "$others" ]; then
    fail "no app saved by make install-app in $apps_dir. Saved by hand, so not chosen here:$others"
  fi
  fail "no app saved by make install-app in $apps_dir"
fi
[ -f "$newest/Contents/Info.plist" ] || fail "$newest has no Contents/Info.plist, so it is not a whole app; nothing was moved"

stamp="${newest##*.prev-}"
now="$(new_stamp)"
if [ -e "$app_path" ]; then
  replaced="$app_path.rolled-back-$now"
  suffix=1
  while [ -e "$replaced" ]; do
    suffix=$((suffix + 1))
    replaced="$app_path.rolled-back-$now-$suffix"
  done
  mv "$app_path" "$replaced"
fi
mv "$newest" "$app_path"
restored=1

echo "Restored $app_path from $newest."
if [ -n "$replaced" ]; then echo "  The app it replaced: $replaced"; fi
backup="$(backup_file_for "$stamp")"
if [ -f "$backup" ]; then
  safety="$(dirname "$(backup_file_for "$now")")"
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

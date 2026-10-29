#!/usr/bin/env bash
# Puts back the app install-app.sh moved aside: the newest /Applications/10db.app.prev-<stamp>.
# The app it replaces is kept as 10db.app.rolled-back-<stamp>. It never touches the database; it
# prints the command that restores the backup taken with that install. It refuses while 10db runs.
# Exit 0: restored. Exit 1: refused, with nothing moved. Exit 2: bad argument.
set -euo pipefail

script_name=rollback-app.sh
# shellcheck source=scripts/release/installed-app.sh
. "$(cd "$(dirname "$0")" && pwd)/installed-app.sh"

[ "$#" -eq 0 ] || {
  echo "usage: rollback-app.sh (no arguments)" >&2
  exit 2
}

refuse_while_running

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

stamp="${newest##*.prev-}"
replaced=""
if [ -e "$app_path" ]; then
  replaced="$app_path.rolled-back-$(new_stamp)"
  mv "$app_path" "$replaced"
fi
mv "$newest" "$app_path"

echo "Restored $app_path from $newest."
if [ -n "$replaced" ]; then echo "  The app it replaced: $replaced"; fi
backup="$(backup_file_for "$stamp")"
if [ -f "$backup" ]; then
  echo "The database backup taken by that install is $backup."
  echo "10db has written to its database since, and a newer build may have migrated it, which the"
  echo "restored app can't read. To go back to the backup, keep 10db quit and run:"
  echo "  sqlite3 \"$db_file\" \".restore '$backup'\""
else
  echo "No database backup matches $stamp (expected $backup), so the database stays as it is."
fi
echo "Then open 10db."

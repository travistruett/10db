#!/usr/bin/env bash
# Installs 10db as GitHub built it from a branch or tag, so this Mac never compiles the app.
#   install-app.sh [ref]    ref is a branch or tag, default main (`make install-app REF=<ref>`)
# It takes the unsigned-dmg artifact of the newest successful release-dry-run run for the ref's
# head commit, or waits for a run of that commit already under way, or starts one and waits for
# it. Then it checks the DMG against SHA256SUMS, backs up the database, zips the current app to
# 10db-previous/10db-<stamp>.zip beside the data directory, copies the new app in, clears its
# quarantine and registers it with Launch Services. Only then does it delete older zips and all
# but the newest 5 database backups. It refuses while 10db runs and never quits it.
# Exit 0: installed. Exit 1: refused or failed; the previous app is put back, and when it can't be,
# the last message says where it is. Exit 2: bad argument.
set -euo pipefail

script_name=install-app.sh
# gh works out {owner}/{repo} from this checkout's origin, wherever make was run from.
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/release/installed-app.sh
. scripts/release/installed-app.sh

usage() {
  echo "usage: install-app.sh [branch-or-tag] (default main)" >&2
  echo "  A name of 7 to 40 hex characters is taken for a commit SHA and refused: GitHub builds only a branch or tag." >&2
  exit 2
}

# A branch or tag name, as `gh workflow run --ref` takes it. Anything that looks like a commit SHA
# is refused: GitHub dispatches a workflow only on a branch or tag.
valid_ref() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || return 1
  if [[ "$1" =~ ^[0-9a-f]{7,40}$ ]]; then return 1; fi
  case "$1" in
    *..* | *//* | */ | *.lock) return 1 ;;
  esac
}

[ "$#" -le 1 ] || usage
ref="${1:-main}"
valid_ref "$ref" || usage

workflow=release-dry-run.yml
artifact=unsigned-dmg
poll_seconds="${TENDB_INSTALL_POLL_SECONDS:-20}"
# The build's own limit is 60 minutes (release-dry-run.yml), plus time queued for a macOS runner.
deadline_seconds="${TENDB_INSTALL_DEADLINE_SECONDS:-5400}"

refuse_while_running

work="$(mktemp -d "${TMPDIR:-/tmp}/10db-install.XXXXXX")"
mount="$(mktemp -d "${TMPDIR:-/tmp}/10db-install-mount.XXXXXX")"
gh_err="$work/gh.err"
mounted=0
backup_dir=""
backup_done=0
previous_zip=""
zip_done=0
removing=0
copying=0
installed=0
backups_kept=5

detach_dmg() {
  hdiutil detach "$mount" -quiet && return 0
  hdiutil detach "$mount" -quiet -force && return 0
  return 1
}

# Never aborts part way: each step runs whatever the one before it did, and a Ctrl-C while it runs
# is ignored. The previous app is unpacked from its zip only into an empty place, so it can't end
# up inside a partial copy; once it is back, its zip goes, leaving the earlier one.
cleanup() {
  trap '' INT TERM HUP
  set +e
  if [ "$mounted" -eq 1 ]; then detach_dmg > /dev/null 2>&1; fi
  rmdir "$mount" 2> /dev/null
  rm -rf "$work"
  if [ -n "$backup_dir" ] && [ "$backup_done" -eq 0 ]; then rm -rf "$backup_dir"; fi
  if [ -n "$previous_zip" ]; then rm -f "$previous_zip.partial"; fi
  if [ "$installed" -eq 0 ]; then
    if [ "$copying" -eq 1 ] || [ "$removing" -eq 1 ]; then rm -rf "$app_path" 2> /dev/null; fi
    if [ "$removing" -eq 1 ]; then
      local bundle=""
      if [ ! -e "$app_path" ] && bundle="$(unpack_app "$previous_zip")" && mv "$bundle" "$app_path"; then
        rmdir "$(dirname "$bundle")" 2> /dev/null
        rm -f "$previous_zip"
        register_app > /dev/null 2>&1
        echo "$script_name: put the previous app back at $app_path" >&2
      else
        echo "$script_name: could not put the previous app back. It is kept in $previous_zip; once $app_path is out of the way, run: ditto -x -k \"$previous_zip\" \"$apps_dir\"" >&2
      fi
    elif [ "$zip_done" -eq 1 ]; then
      rm -f "$previous_zip"
    fi
  fi
  release_lock
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if ! sha="$(gh api "repos/{owner}/{repo}/commits/$ref" --jq .sha 2> "$gh_err")"; then
  grep -q 'No commit found' "$gh_err" && fail "GitHub has no branch or tag named $ref"
  fail "gh could not ask GitHub about $ref: $(cat "$gh_err"). Check gh auth status and the network."
fi
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "GitHub answered '$sha' for the head of $ref, not a commit SHA"

run_id="$(gh run list --workflow "$workflow" --commit "$sha" --status success --limit 1 \
  --json databaseId --jq '.[0].databaseId // empty')"
if [ -n "$run_id" ]; then
  live="$(gh api "repos/{owner}/{repo}/actions/runs/$run_id/artifacts" \
    --jq "[.artifacts[] | select(.name == \"$artifact\" and (.expired | not))] | length")"
  if [ "$live" -eq 0 ]; then
    echo "The build of ${sha:0:12} in run $run_id has expired (GitHub keeps it for 7 days)."
    run_id=""
  else
    echo "Using the build of $ref at ${sha:0:12} from run $run_id."
  fi
fi

if [ -z "$run_id" ]; then
  run_id="$(gh run list --workflow "$workflow" --commit "$sha" --limit 20 --json databaseId,status \
    --jq '[.[] | select(.status != "completed")][0].databaseId // empty')"
  [ -z "$run_id" ] || echo "A build of ${sha:0:12} is already under way in run $run_id; waiting for it."
fi

dispatched_runs() {
  gh run list --workflow "$workflow" --branch "$ref" --event workflow_dispatch --limit 20 \
    --json databaseId --jq '.[].databaseId'
}

started=$SECONDS
past_deadline() { [ $((SECONDS - started)) -ge "$deadline_seconds" ]; }

if [ -z "$run_id" ]; then
  # gh workflow run does not say which run it started, so the new run is the one that wasn't there before.
  before="$(dispatched_runs)"
  gh workflow run "$workflow" --ref "$ref"
  echo "Started a build of $ref on GitHub; the first build of a commit takes about 15 minutes."
  while [ -z "$run_id" ]; do
    for id in $(dispatched_runs); do
      if ! grep -qx "$id" <<< "$before"; then
        run_id="$id"
        break
      fi
    done
    if [ -z "$run_id" ]; then
      past_deadline && fail "the build GitHub was asked to start never appeared; see gh run list --workflow $workflow"
      sleep "$poll_seconds"
    fi
  done
fi
[[ "$run_id" =~ ^[0-9]+$ ]] || fail "GitHub answered '$run_id' for a run id"

# A long wait meets the odd failed request (a 502, a dropped connection); only three in a row stop it.
view_failures=0
while :; do
  if view="$(gh run view "$run_id" --json status,conclusion,headSha --jq '.status, .conclusion, .headSha' 2> "$gh_err")"; then
    view_failures=0
    { read -r status; read -r conclusion; read -r head; } <<< "$view"
    [ "$status" != completed ] || break
  else
    view_failures=$((view_failures + 1))
    [ "$view_failures" -lt 3 ] || fail "gh could not report on run $run_id three times running: $(cat "$gh_err")"
  fi
  past_deadline && fail "run $run_id did not finish in $deadline_seconds seconds; follow it with gh run watch $run_id, then run this again"
  sleep "$poll_seconds"
done
[ "$conclusion" = success ] || fail "run $run_id ended in $conclusion; read it with gh run view $run_id --log-failed"
[[ "$head" =~ ^[0-9a-f]{40}$ ]] || fail "run $run_id reports '$head' as its commit"

gh run download "$run_id" --name "$artifact" --dir "$work/artifact"

shopt -s nullglob
dmgs=("$work/artifact"/*.dmg)
[ "${#dmgs[@]}" -eq 1 ] || fail "expected one DMG in run $run_id's $artifact, found ${#dmgs[@]}"
dmg="${dmgs[0]}"
sums="$work/artifact/SHA256SUMS"
[ -f "$sums" ] || fail "run $run_id's $artifact has no SHA256SUMS"
# SHA256SUMS comes in the same artifact as the DMG, so this catches a corrupt or truncated download,
# not a forged one. Trust rests on gh fetching the builder's own run over GitHub's authenticated API,
# from a workflow that holds no secrets and builds exactly the commit the run names.
expected="$(awk -v name="$(basename "$dmg")" '$2 == name || $2 == "*" name { print $1 }' "$sums")"
actual="$(shasum -a 256 "$dmg" | awk '{ print $1 }')"
[ -n "$expected" ] || fail "SHA256SUMS does not list $(basename "$dmg")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $(basename "$dmg"): SHA256SUMS says $expected, the download is $actual"

take_lock
# 10db may have been opened while the build ran.
refuse_while_running

stamp="$(new_stamp)"
[ ! -e "$(previous_zip_for "$stamp")" ] || fail "$(previous_zip_for "$stamp") already exists"
backup=""
if [ -f "$db_file" ]; then
  backup="$(backup_file_for "$stamp")"
  case "$backup" in *"'"*) fail "the backup path holds a single quote, which sqlite3's .backup can't take: $backup" ;; esac
  mkdir "$(dirname "$backup")" || fail "could not create $(dirname "$backup")"
  backup_dir="$(dirname "$backup")"
  # SQLite's own backup API: a consistent copy that takes the write-ahead log into account.
  if ! sqlite3 "$db_file" ".backup '$backup'" || [ ! -s "$backup" ]; then
    fail "sqlite3 could not back up $db_file, so nothing was moved"
  fi
  backup_done=1
else
  echo "There is no database at $db_file yet, so there is nothing to back up."
fi

# 10db may have been opened during the backup.
refuse_while_running

if [ -e "$app_path" ]; then
  previous_zip="$(previous_zip_for "$stamp")"
  zip_app "$previous_zip" || fail "could not zip $app_path to $previous_zip and test the zip, so the app stays in place"
  zip_done=1
  removing=1
  rm -rf "$app_path"
fi

# Set first: an attach that fails part way may still leave the image mounted.
mounted=1
hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg" > /dev/null
apps=("$mount"/*.app)
[ "${#apps[@]}" -eq 1 ] || fail "expected one app in the DMG, found ${#apps[@]}"
copying=1
ditto "${apps[0]}" "$app_path"
if detach_dmg; then
  mounted=0
else
  echo "$script_name: could not detach the DMG at $mount, even with -force; the app is installed. Eject it in Finder later." >&2
fi

# Safe to clear: the app is the builder's own CI build of a named commit, fetched through gh, and
# its DMG matched the run's SHA256SUMS above.
clear_quarantine
installed=1
register_app

# The newest backups by time last changed, whatever their names: backups made by hand are named
# with hours and minutes only.
prune_backups() {
  local prefix path count=0 removed=""
  prefix="$(dirname "$data_dir")/$(basename "$data_dir")-backup-"
  local found=("$prefix"*)
  [ "${#found[@]}" -gt "$backups_kept" ] || return 0
  while IFS= read -r path; do
    case "$path" in "$prefix"*) ;; *) continue ;; esac
    [ -d "$path" ] || continue
    count=$((count + 1))
    [ "$count" -gt "$backups_kept" ] || continue
    rm -rf "$path" && removed="$removed $(basename "$path")"
  done <<< "$(ls -1dt -- "${found[@]}")"
  [ -z "$removed" ] || echo "  Removed older database backups, keeping the newest $backups_kept:$removed"
}

echo "Installed 10db from $ref at commit $head (GitHub run $run_id) as $app_path."
if [ -n "$backup" ]; then echo "  Database backup:  $backup"; fi
if [ -n "$previous_zip" ]; then
  keep_only_zip "$previous_zip"
  echo "  Previous app:     $previous_zip"
fi
prune_backups
echo "Open 10db to start it. To go back to the previous app: quit 10db, then run make rollback-app."

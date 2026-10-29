#!/usr/bin/env bash
# Installs 10db as GitHub built it from a branch or tag, so this Mac never compiles the app.
#   install-app.sh [ref]    ref is a branch or tag, default main (`make install-app REF=<ref>`)
# It takes the unsigned-dmg artifact of the newest successful release-dry-run run for the ref's
# head commit, or starts that workflow and waits for it. Then it checks the DMG against
# SHA256SUMS, backs up the database, keeps the current app as 10db.app.prev-<stamp>, copies the new
# app in and clears its quarantine. It refuses while 10db runs and never quits it.
# Exit 0: installed. Exit 1: refused or failed, with the previous app still in place. Exit 2: bad
# argument.
set -euo pipefail

script_name=install-app.sh
# shellcheck source=scripts/release/installed-app.sh
. "$(cd "$(dirname "$0")" && pwd)/installed-app.sh"

usage() {
  echo "usage: install-app.sh [branch-or-tag] (default main)" >&2
  exit 2
}

# A branch or tag name as `gh workflow run --ref` takes it. A commit SHA is not accepted: GitHub
# dispatches a workflow only on a branch or tag.
valid_ref() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || return 1
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
mounted=0
moved_to=""
copying=0
installed=0
cleanup() {
  if [ "$mounted" -eq 1 ]; then hdiutil detach "$mount" -quiet || true; fi
  rmdir "$mount" 2> /dev/null || true
  rm -rf "$work"
  if [ "$installed" -eq 0 ]; then
    if [ "$copying" -eq 1 ]; then rm -rf "$app_path"; fi
    if [ -n "$moved_to" ]; then
      mv "$moved_to" "$app_path"
      echo "$script_name: put the previous app back at $app_path" >&2
    fi
  fi
}
trap cleanup EXIT

sha="$(gh api "repos/{owner}/{repo}/commits/$ref" --jq .sha)" || fail "GitHub has no branch or tag named $ref"
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

while :; do
  view="$(gh run view "$run_id" --json status,conclusion,headSha --jq '.status, .conclusion, .headSha')"
  { read -r status; read -r conclusion; read -r head; } <<< "$view"
  [ "$status" != completed ] || break
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

# 10db may have been opened while the build ran.
refuse_while_running

stamp="$(new_stamp)"
backup=""
if [ -f "$db_file" ]; then
  backup="$(backup_file_for "$stamp")"
  case "$backup" in *"'"*) fail "the backup path holds a single quote, which sqlite3's .backup can't take: $backup" ;; esac
  mkdir "$(dirname "$backup")"
  # SQLite's own backup API: a consistent copy that takes the write-ahead log into account.
  sqlite3 "$db_file" ".backup '$backup'"
  [ -s "$backup" ] || fail "sqlite3 wrote no backup at $backup"
else
  echo "There is no database at $db_file yet, so there is nothing to back up."
fi

if [ -e "$app_path" ]; then
  [ ! -e "$app_path.prev-$stamp" ] || fail "$app_path.prev-$stamp already exists"
  mv "$app_path" "$app_path.prev-$stamp"
  moved_to="$app_path.prev-$stamp"
fi

hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg" > /dev/null
mounted=1
apps=("$mount"/*.app)
[ "${#apps[@]}" -eq 1 ] || fail "expected one app in the DMG, found ${#apps[@]}"
copying=1
ditto "${apps[0]}" "$app_path"
hdiutil detach "$mount" -quiet
mounted=0

# The build is unsigned, so Gatekeeper refuses any copy that carries com.apple.quarantine. This
# clears it on the installed app alone: the app is the builder's own CI build of a named commit,
# fetched through gh, and its DMG matched the run's SHA256SUMS above.
xattr -r -d com.apple.quarantine "$app_path"
attributes="$(xattr -r -l "$app_path")"
case "$attributes" in *com.apple.quarantine*) fail "com.apple.quarantine is still set inside $app_path" ;; esac
installed=1

echo "Installed 10db from $ref at commit $head (GitHub run $run_id) as $app_path."
if [ -n "$backup" ]; then echo "  Database backup:  $backup"; fi
if [ -n "$moved_to" ]; then echo "  Previous app:     $moved_to"; fi
echo "Open 10db to start it. To go back to the previous app: quit 10db, then run make rollback-app."

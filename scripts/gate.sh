#!/usr/bin/env bash
# Runs every repository check and prints one summary line, which gives each step's seconds in the order
# the steps ran. Each step's output goes to .gate/<step>.log.
# GATE_STEPS="lint test" limits the run (used by tests and for quick reruns). GATE_SKIP_RUST=1
# reports rust as skipped even when cargo is installed (the Ubuntu CI job: no Tauri system libraries).
# Inside a sandbox (TENDB_SANDBOX=1, as a gate 10db runs has it; any other value runs it) e2e is
# reported as skipped. With CI set, each failing step's last 150 log lines are printed before the
# summary line.
set -uo pipefail
cd "$(dirname "$0")/.."
# Logs from an earlier run would otherwise sit beside this run's, and a skipped step leaves none.
rm -rf .gate
mkdir -p .gate

ALL_STEPS=(format lint typecheck test build e2e drift knip rust)
read -r -a steps <<< "${GATE_STEPS:-${ALL_STEPS[*]}}"
start=$SECONDS
# One entry per step, passed or failed: "lint 31s" or "rust skipped".
steps_run=()
failed=()

run_step() {
  local name=$1 began=$SECONDS
  shift
  "$@" > ".gate/$name.log" 2>&1 || failed+=("$name")
  steps_run+=("$name $((SECONDS - began))s")
}

for step in "${steps[@]}"; do
  case "$step" in
    format) run_step format pnpm -s format:check ;;
    lint) run_step lint pnpm -s lint ;;
    typecheck) run_step typecheck pnpm -s typecheck ;;
    test) run_step test pnpm -s test ;;
    build) run_step build pnpm -s build ;;
    e2e)
      # WebKit runs its page, network and GPU processes as XPC services that launchd starts outside
      # the caller's sandbox, so a sandboxed gate (TENDB_SANDBOX=1) never starts it; CI runs it.
      if [[ "${TENDB_SANDBOX:-}" == 1 ]]; then
        steps_run+=("e2e skipped (sandboxed)")
      else
        run_step e2e pnpm -s --filter @10db/desktop e2e
      fi
      ;;
    drift) run_step drift pnpm -s drift ;;
    knip) run_step knip pnpm -s knip ;;
    rust)
      if [[ -z "${GATE_SKIP_RUST:-}" ]] && command -v cargo > /dev/null 2>&1; then
        run_step rust make -s rust-check
      else
        steps_run+=("rust skipped")
      fi
      ;;
    fail-probe) run_step fail-probe false ;;
    *) failed+=("unknown-step:$step") ;;
  esac
done

elapsed=$((SECONDS - start))
# CI keeps no .gate/ directory, so a failing step's log is printed there, before the summary line.
if [[ -n "${CI:-}" ]]; then
  for name in ${failed[@]+"${failed[@]}"}; do
    [[ -f ".gate/$name.log" ]] || continue
    echo "::group::$name log (last 150 lines)"
    tail -n 150 ".gate/$name.log"
    echo "::endgroup::"
  done
fi
breakdown=
# bash 3.2 treats expanding an empty array as unbound under set -u.
if ((${#steps_run[@]})); then
  breakdown=$(printf '%s · ' "${steps_run[@]}")
  breakdown=${breakdown% · }
fi
if ((${#failed[@]} == 0)); then
  echo "GATE PASS $breakdown (${elapsed}s)"
else
  echo "GATE FAIL: ${failed[*]} — logs in .gate/${breakdown:+; $breakdown} (${elapsed}s)"
  exit 1
fi

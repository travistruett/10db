#!/usr/bin/env bash
# Runs every repository check and prints one summary line. Each step's output goes to .gate/<step>.log.
# GATE_STEPS="lint test" limits the run (used by tests and for quick reruns). GATE_SKIP_RUST=1
# reports rust as skipped even when cargo is installed (the Ubuntu CI job: no Tauri system libraries).
set -uo pipefail
cd "$(dirname "$0")/.."
# Logs from an earlier run would otherwise sit beside this run's, and a skipped step leaves none.
rm -rf .gate
mkdir -p .gate

ALL_STEPS=(format lint typecheck test build e2e drift knip rust)
read -r -a steps <<< "${GATE_STEPS:-${ALL_STEPS[*]}}"
start=$SECONDS
passed=()
failed=()

run_step() {
  local name=$1
  shift
  if "$@" > ".gate/$name.log" 2>&1; then passed+=("$name"); else failed+=("$name"); fi
}

for step in "${steps[@]}"; do
  case "$step" in
    format) run_step format pnpm -s format:check ;;
    lint) run_step lint pnpm -s lint ;;
    typecheck) run_step typecheck pnpm -s typecheck ;;
    test) run_step test pnpm -s test ;;
    build) run_step build pnpm -s build ;;
    e2e) run_step e2e pnpm -s --filter @10db/desktop e2e ;;
    drift) run_step drift pnpm -s drift ;;
    knip) run_step knip pnpm -s knip ;;
    rust)
      if [[ -z "${GATE_SKIP_RUST:-}" ]] && command -v cargo > /dev/null 2>&1; then
        run_step rust make -s rust-check
      else
        passed+=("rust skipped")
      fi
      ;;
    fail-probe) run_step fail-probe false ;;
    *) failed+=("unknown-step:$step") ;;
  esac
done

elapsed=$((SECONDS - start))
if ((${#failed[@]} == 0)); then
  echo "GATE PASS ${passed[*]} (${elapsed}s)"
else
  echo "GATE FAIL: ${failed[*]} — logs in .gate/ (${elapsed}s)"
  exit 1
fi

# Task 0: spike — what each real suite needs under the gate sandbox

**Output:** a short report at `~/Agents/scratch/10db/2026-11-25/evals-2-5/s5/spike.md`, no code merged. It decides
whether tasks 2–4 need more than the plan says. **Spend nothing:** never run a live eval or any command that calls
a paid model.

- **ampsio** (`~/Projects/ampsio`, Docker): the builder's stack may be down; don't start or stop it. Test what the
  sandbox does to compose with the plan's Docker profile: under `apps/daemon/scripts/sandboxed-gate.ts` (add
  `--docker` and `--dot-env` flags to the script if it has none; that change is task 2's, so keep it on this branch),
  run `docker compose config --quiet` and `make -n eval TASK=chat.answer` in ampsio's checkout. Record: does compose
  start with `.env` readable and the Docker socket open; what else `make eval`'s recipe touches before
  `docker compose exec` (`amps/dev_export.py verify-backend`: what it reads, any host). Propose ampsio's
  `stopCommand` (one `docker compose exec -T backend …` that ends a `run_eval` process) from its code.
- **orgtools** (`~/Projects/orgtools`, Bedrock): find how its evals run (`tests/eval/test_*_eval.py`, Makefile, CI)
  and what a live eval reads: the AWS profile and region variables, any `.env` load (dotenv, pydantic-settings), any
  host other than `bedrock-runtime.<region>.amazonaws.com` (STS, SSO). Run its collection step only
  (`pytest --collect-only` on one eval file) under `sandboxed-gate.ts` with no hosts, and record what fails.
- For each: the `live` entry the manifest should hold (hosts, secret, docker, loopback, stopCommand, timeout), and
  anything the plan can't do (a second secret, a `.env` read by a non-Docker suite). The latter goes to the
  coordinator as a product question; don't decide it.

**Done:** report at `~/Agents/scratch/10db/2026-11-25/evals-2-5/s5/spike.md`, code in `5ef52cb08`.

.PHONY: setup gate check rust-check deny github-settings live-acceptance install-app rollback-app

TAURI_DIR := apps/desktop/src-tauri
REF ?= main

## setup: install the pinned tools and dependencies; safe to rerun. INSTALL_RUST=yes|no answers the Rust question.
setup:
	@bash scripts/setup.sh

## gate: every check; prints one summary line.
gate:
	@bash scripts/gate.sh

## check: fast focused check on changed files.
check:
	@bash scripts/check.sh

## rust-check: fmt, clippy (pedantic, warnings are errors) and tests for the Tauri shell.
rust-check:
	pnpm --filter @10db/desktop sidecar
	cd $(TAURI_DIR) && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test

## live-acceptance: manual §1.3 run on real Claude Code (subscription only; never CI).
live-acceptance:
	@bash scripts/live-acceptance.sh

## deny: cargo-deny advisories, licences, bans and sources for the Tauri crate.
deny:
	cargo deny --manifest-path $(TAURI_DIR)/Cargo.toml --config deny.toml check

## github-settings: apply .github/rulesets and the repo settings to GitHub. Needs admin rights;
## run by hand once the repository exists, never in CI.
github-settings:
	node scripts/github-settings.mjs

## install-app: install 10db as GitHub built it from REF (default main); quit 10db first. Never
## builds on this Mac; backs up the database and keeps the current app as 10db.app.prev-<stamp>.
install-app:
	@bash scripts/release/install-app.sh "$(REF)"

## rollback-app: put back the app the last install-app replaced; prints the database restore command.
rollback-app:
	@bash scripts/release/rollback-app.sh

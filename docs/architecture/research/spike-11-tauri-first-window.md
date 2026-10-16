# Spike 11: Rust toolchain and the first Tauri 2 window

- **Status:** VERIFIED
- **Date:** 2026-10-15
- **Versions:** rustc 1.99.0 (b940084d7 2026-09-28), tauri 2.12.3 (tauri-build 2.7.2), @tauri-apps/cli 2.12.2, macOS 15.7.7

## What was done

Installed Rust via mise (which runs rustup-init) with `rust-toolchain.toml` pinning 1.99.0, scaffolded
`apps/desktop/src-tauri` by hand (no `create-tauri-app`), generated icons from a placeholder PNG, ran
`tauri dev` against the Vite dev server and the daemon (with `TENDB_DATA_DIR` pointing at a temp directory),
and captured the app window.

## Findings

- First `cargo build` time: the dependency graph (about 400 crates) compiled in 25 s for the first
  `cargo clippy` and 28 s for the first `cargo test` on an Apple Silicon Mac. Incremental rebuild after touching
  `lib.rs`: 2.6 s. `target/` grows to 2.5 GB after clippy, test and dev builds, so it stays git-ignored.
- Identifier `app.10db.desktop`: accepted. Tauri did not reject the segment that starts with a digit, so
  `app.tendb.desktop` is not needed.
- CSP: the UI reached the daemon at 127.0.0.1:4317 yes. The window showed the **Daemon connected** badge under
  the CSP in `tauri.conf.json`, with the Vite dev server on port 1420 serving the page.
- `mise install rust` installed 1.99.0 with clippy and rustfmt in about 8 s. It left `mise.lock` unchanged,
  because the lock already held the rust entry. `mise install --locked rust` then succeeds.
- Anything surprising for a first-time Rust user: after `mise install rust`, `rustup show active-toolchain`
  reports `1.99.0-aarch64-apple-darwin (overridden by environment variable RUSTUP_TOOLCHAIN)`. The shims set
  `RUSTUP_TOOLCHAIN`, so `rust-toolchain.toml` and mise agree but rustup reports the environment as the source.
  rustup-init also suggests adding `~/.cargo/bin` to PATH; with mise shims that is not needed.
  `tauri icon` also writes Android and iOS icon sets into `icons/`, which are unused on macOS but harmless.

## Consequence for M1

M1b builds on this shell: sidecar daemon, tray, close-to-tray. No changes needed. The window label `main`,
the capability file and the CSP already allow the daemon's origin. The sidecar will need a `bundle.externalBin`
entry and a shell or process capability, and a CSP `connect-src` change only if the daemon port stops being 4317.

# Spike 08: The daemon as a Tauri 2 sidecar

- **Status:** VERIFIED (externalBin approach); SEA evaluated and works with workarounds, not adopted
- **Date:** 2026-10-16
- **Versions:** Node 26.12.0 · tauri 2.12.4 (Cargo.lock) · @tauri-apps/cli 2.12.2 · macOS 15.7.7
- **Command:** `pnpm --filter @10db/desktop sidecar && pnpm --filter @10db/desktop tauri build --bundles app`

## Question

A Node single-executable sidecar inside Tauri 2: signing and PATH.

## Result

The shipped approach is the pinned Node binary as `externalBin` (`binaries/tendb-node-<triple>`), with
`daemon/daemon.mjs`, `daemon/drizzle/` and `daemon/better_sqlite3.node` as resources. The daemon opens SQLite
through better-sqlite3's `nativeBinding` option, so the bundle needs no node_modules.
The built `.app` contains `Contents/MacOS/tendb-node` and `Contents/Resources/daemon/`, and running
`tendb-node daemon.mjs` from inside the `.app` with a data directory containing a space answered `/health`
and exited 0 on SIGTERM. A bundle test (`apps/daemon/test/bundle.test.ts`) proves the same from a temp
directory with no node_modules above it. The copied Node binary must be re-signed after copying; the
ad-hoc signature is enough for local builds.

## Evidence

- `.app` size: 159M; `tendb-node` size: 147338960 bytes (about 141 MiB); `resources/daemon` size: 8.0M
  (daemon.mjs 2.3 MB, its sourcemap 4.0 MB, better_sqlite3.node 2.0 MB, drizzle/).
- Cold start to `/health` from the shipped binary: 1.47 s on the first run after the build (the first
  execution of a freshly signed binary), 0.15 s on a repeat run.
- `codesign --verify --verbose` on the copied Node binary after ad-hoc signing:
  `tendb-node: valid on disk` and `tendb-node: satisfies its Designated Requirement`.
- `spctl --assess --type execute` on the unsigned app: `10db.app: code has no resources but signature
indicates they must be present`, exit 1 (rejected, expected for a local development build).
- `launchctl getenv PATH`: empty output, exit 0. GUI apps start with `/usr/bin:/bin:/usr/sbin:/sbin`, which
  has no `claude`.

## SEA evaluation (45-minute timebox)

Finished well inside the timebox. Node 26.12.0 has no `--build-sea` flag (`node: bad option: --build-sea`),
so the older route is the one that works: `node --experimental-sea-config sea.json` with
`{"main":"daemon.mjs","mainFormat":"module"}` writes the blob, and `postject` injects it into a copy of the
real Node binary (not the mise shim), followed by an ad-hoc `codesign`.

- **ESM entry:** supported through `mainFormat: "module"`; top-level await in the bundle works. The blob must
  be written by the same Node version as the binary it is injected into: a blob made by Node 25.2.1 aborted
  the 26.12.0 binary with `Assertion failed: (format_value) <= (static_cast<uint8_t>(ModuleFormat::kModule))`.
- **Native addon:** better-sqlite3 failed with `ReferenceError: __dirname is not defined` when given no
  path, as expected. With `TENDB_SQLITE_BINDING` pointing at an addon file on disk it loaded, so the addon
  must stay a file beside the binary (or be extracted at startup).
- **Migrations:** the bundle resolves its migrations relative to `import.meta.dirname`, which inside a SEA
  does not name the executable's own directory (it pointed one level above it), so the migrations were not
  found (`ENOENT .../drizzle/meta/_journal.json`). They need an explicit directory or SEA assets plus extraction.
  With a copy of `drizzle/` at the path the daemon looked in, the SEA daemon answered `/health`.
- **Size and start:** the SEA binary is 148839120 bytes against 147338960 for plain Node, and started to
  `/health` in 0.21 s, the same as externalBin warm (0.15 s).
- **Why it is not adopted:** it ships the same set of files (addon and migrations stay outside the binary),
  adds postject and a per-Node-version blob step, and changes how `import.meta.dirname` path lookups work.
  externalBin keeps the ESM bundle unchanged.

## Consequence for M1

- Task 8's supervisor launches `Contents/MacOS/tendb-node Contents/Resources/daemon/daemon.mjs` with
  `TENDB_PORT=0`.
- Task 2 captures the login-shell environment, because a GUI-launched sidecar sees only the PATH above.
- A distributed build needs a Developer ID signature and notarization covering the nested Node binary.
  That is out of scope until there is a release; the ad-hoc signature is for local builds only.
- `pnpm sidecar` must run under the pinned Node (it refuses otherwise), and `make rust-check` now runs it
  first because tauri-build requires `externalBin` and `resources` to exist.
- The bundle also ships `daemon.mjs.map` (4 MB); Task 7 can drop it from the resources if size matters.

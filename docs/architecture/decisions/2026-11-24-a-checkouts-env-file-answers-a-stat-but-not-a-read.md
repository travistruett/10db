# A checkout's .env file answers a stat in the gate sandbox but is never read

- **Date:** 2026-11-24

## Decision

In the gate sandbox (srt), a `.env*` regular file inside the checkout, or a link that leads to one, keeps
its contents closed but answers `stat` and `access`: its existence, size and mtime are visible. A read of
it, and a rename or removal of it, are refused. A `.env*` folder, and a link that leads outside the
checkout, stay closed down to a stat. `sandbox/secret-stat.ts` (`splitSecrets`) decides which; the gate puts
the first kind in `filesystem.denyReadData`, a field only 10db's patched srt has
(`patches/@anthropic-ai__sandbox-runtime@0.0.81.patch`): `(deny file-read-data)` and
`(deny file-write-unlink)` on the path, with `file-read-metadata` left to the profile's default. Drop the
patch once srt has a data-only deny.

Lane sandboxes are not changed: Claude Code runs its own bundled srt from the settings 10db hands it,
which has no such field, and Codex's permission profile has `deny` and no stat-only access. A lane still
cannot stat a `.env*` file in its checkout; a follow-up closes the gap when either provider gets one.

## Why

The hard limit is reading secrets (`AGENTS.md`, "Trust the developer, contain the agent"); that a file
exists is not a secret, and Claude Code itself lets a command stat `.env`. Seatbelt's `file-read*`, which
srt emits for every `denyRead` entry, includes metadata, so `make: stat: .env: Operation not permitted`
failed every Makefile that lists `.env` as a prerequisite, `make gate` of Ampsio first, and `make` then
tried to copy `.env.example` over it.

- **Allowing the whole `.env*` read** was turned down: the contents are the secret.
- **A shim that fakes the `stat`** was turned down: `make` and `docker compose` call the kernel.
- **Opening metadata for every denied path** (a one-line patch of srt's `file-read*` denies) was turned
  down: it would show the existence and size of every file on the host, not only the checkout's `.env*`.
- A link in the checkout can lead to a `.env` that is also a file in the checkout (a copied tree holds
  such links). srt denies a link's target as well, so the link stays in the data-only list too, or it
  would close the file it leads to.

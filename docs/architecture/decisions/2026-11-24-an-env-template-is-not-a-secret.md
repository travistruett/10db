# A .env template is not a secret

- **Date:** 2026-11-24
- **Amends:** decisions 91 and 132

## Decision

A `.env*` file name that ends in `.example`, `.sample` or `.template` (`.env.example`, `.env.local.sample`,
`.env.template`), compared in the file system's case fold, is not a secret. `isSecretFileName`
(`apps/daemon/src/guard/paths.ts`) answers false for it, so lanes on every provider (Claude Code's profile and
Codex's `deny`), the gate, the file-access judge's fast path and chat's commits treat it as an ordinary file.
Every other `.env*` name stays closed, including one that only holds a template ending in the middle
(`.env.example.local`). This covers the checkout: an opened setup read (`sandbox/setup-dir.ts`) and copied
project definitions (`session-setup/project-definitions.ts`) keep every `.env*` name closed, templates included.

## Why

The hard limit is reading secrets (`AGENTS.md`, "Trust the developer, contain the agent"). A template holds
placeholders and is committed so that everyone who clones the project can read it, so reading it reveals no
secret. Claude Code doesn't close it either.

Closing it broke the common way a project's tools run without its `.env`. Ampsio's Makefile points
`COMPOSE_ENV_FILES` at `.env.example` when `TENDB_SANDBOX=1`, and every `docker compose exec` in its gate then
failed with `open .env.example: operation not permitted`. A copy of the same file under a name outside `.env*`
passed in the same gate sandbox.

- **Exempting only files git tracks** was turned down: a template is the convention for "no secrets here"
  whether or not it is committed yet, and asking git for every walked file costs a call per checkout per
  session for little gain.
- **Asking projects to rename their templates** was turned down: `.env.example` is the name nearly every
  framework and tutorial uses.
- Cost if wrong: a builder who keeps real values in a file named like a template has them readable to
  lanes. They can rename it to any other `.env*` name to close it again.

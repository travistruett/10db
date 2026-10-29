# A folder is inspected as data, outside the pin and trust machinery, before it becomes a project

- **Date:** 2026-10-28

## Decision

- The project folder is chosen in the native folder panel (Tauri's dialog plugin, `dialog:allow-open` only). The
  browser UI types the path instead. Either way the daemon inspects the folder (`POST /folders/inspect`) and
  reports the repository's root, branches, default branch, remote and candidate gate commands.
- Inspection reads `Makefile`, `package.json` and the names of a few other files as data: a link, a non-regular
  file or a file over 256 KiB counts as absent. It runs only the daemon's own read-only git subcommands, each
  with hooks and fsmonitor off, and never `pinned()`. Nothing from the repository runs and no Inbox card is
  raised: git's refusal of the repository is an answer to the request.
- A folder that is a registered checkout, is inside one, contains one, or lies under 10db's own directories is
  refused by its real path before git is asked anything about it.
- A package manager named by `package.json` reaches the prefilled gate command only when it is npm, pnpm, yarn
  or bun; anything else falls back to the lockfile. The repository proposes the gate command and the builder
  accepts it; it runs only under the gate sandbox.

## Why

The folder isn't trusted until it is a project, and the daemon never runs repository code on the host. A folder
the builder may never add must not produce trust cards. A web page never gets a picked folder's absolute path
from the browser, so the native panel hands the path to the daemon and the daemon reports what the folder holds
instead of the UI guessing. The dialog plugin is pinned at the latest stable release, which is older than the
supply-chain minimum age, so no held-back pin needs a decision.

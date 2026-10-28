# A pull request's title is written from its tasks and the paths it changed

- **Date:** 2026-10-28
- **Amends:** the batch delivery design (`docs/superpowers/specs/2026-10-21-10db-batch-delivery-design.md`
  §6 step 4, the `<pr_title_prefix>: <title>` title)

## Decision

When a project sets no PR title prefix, `gh pr create` gets `<type>(<scope>): <subject>`, built at ship time
in `apps/daemon/src/delivery/`:

- **Type:** `fix` when every task in the batch has a title whose first word is fix, fixes or fixed;
  otherwise `feat`. A feature that carries the fix tasks from its review stays a feature.
- **Scope:** read from `.10db/pr-scopes.json` in the commit being shipped, through git as the pull request
  template is (`{"scopes": {"<scope>": ["<file or directory>", ...]}}`). Each file the batch committed
  between its base and the shipped commit goes to the scope whose entry covers it most closely. The title
  gets that scope only when every file falls under the same one. Files under two scopes, a file under
  none, no file at all, or a missing or invalid list mean no scope. A scope is a lowercase word, and a
  path is relative, with no `.`, `..` or empty steps.
- **Subject:** the batch title with its first letter lowercased, no trailing full stop, cut at a word so
  the header stays within commitlint's 100 characters.
- **Override:** a project prefix, when set, is used in place of the derived type and scope, as before.

This repository lists its scopes in `.10db/pr-scopes.json`: every `scope-enum` entry in
`commitlint.config.js` but `deps`, which names a kind of change rather than a place. A repo test keeps the
two lists the same and checks that every listed path exists.

## Why

One prefix per project mislabels any pull request that spans areas. The scope list has to be data:
`commitlint.config.js` is JavaScript, and the daemon runs nothing from a checkout (lane sandbox spec D13).
Reading the scope list from the shipped commit keeps the checkout out of it, as with the template.
Turned down:

- Taking scopes from top-level directories: in this repo `docs`, `ci` and `repo` aren't directory names.
- A scope map stored on the project: it would duplicate the repo's own list in 10db's database.
- `fix` when any task is a fix: a feature with one fix task would be released as a patch.

Pull request delivery still requires a prefix when a project is saved (`ProjectInput`, `patchProject` and
the desktop forms), so a derived title appears only once that rule is dropped. That change, and the Start
sheet showing the proposed title, are follow-ups.

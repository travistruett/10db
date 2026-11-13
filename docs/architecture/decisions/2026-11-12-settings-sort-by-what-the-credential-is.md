# Settings sort connections by what the credential is, and OpenRouter is an account

- **Date:** 2026-11-12
- **Amends:** `2026-10-31-openrouter-makes-routine-decisions.md` (the OpenRouter key's status moves from
  Settings › Decisions to an account) and decision 65 (the Artificial Analysis key gets a Settings UI; its
  attribution rule holds)

## Decision

Design: `docs/superpowers/specs/2026-11-12-10db-settings-explicit-design.md`.

- **Sort by what the credential is, not by the feature that uses it.** Accounts hold model access: anything that
  pays for model calls, OpenRouter included. Integrations hold outside services that are not models: GitHub,
  Slack and Artificial Analysis. A feature picks an account; the judge picks in Decisions.
- **OpenRouter is an account kind, `openrouter`.** It has a label and a key, stored as the account's own Keychain
  item `account:<id>` with the fingerprint check every account secret has. The judge reads the key of the account
  it runs on (`judge.accountId`). On start, a key found under `openrouter-api-key` becomes an account, and the old
  item is removed only after the new one reads back. `PUT/DELETE /judge/key` and `POST /judge/test` are gone; the
  account carries Test. The account says "Can't run agents yet", and Billing refuses it for a project; a gap is
  stated in the UI, never hidden.
- **The Artificial Analysis key is set from Settings › Integrations** (`PUT/DELETE /benchmarks/key`), into the
  same Keychain item as before. Decision 65's rule that every view of its data carries AA's name and link is
  unchanged: the linked name (`ArtificialAnalysisCredit`) is that attribution.
- **GitHub signs in from the app** (`POST /github/signin` runs `gh auth login --web`), with gh's own login: the
  card has no sign-out because the login is the Mac's, shared with the builder's terminal.
- **Settings shows one scope at a time.** A "This project" / "All projects" switch picks the scope; the sidebar
  lists that scope's sections under subheads and fits 1280×720. The order, Back to Board, the project's sections,
  then the app-wide ones, holds; only one half shows. An Overview opens All projects.
- **Teal is the colour of a working connection.** In Overview, Integrations and account status: teal = works,
  yellow = needs the builder, gray = off; never green or red, and a dot always has words. This sits beside
  `DESIGN.md`'s green rule, which is unchanged for tasks and goals.
- **No notices.** Moving a key, or any other change here, adds no one-time banner, toast or "what's new" line.
- No page sends the builder to a terminal or the Keychain, except to install a missing tool.

## Why

The builder asked for settings that are explicit, not implicit. Sorted by feature, one key sat under Decisions and
two services had no UI; sorted by credential, each place holds one kind of thing, and an account that pays for
model calls could later run agents without moving between pages. Teal for status was the builder's preference over
green and red, since nothing here has failed in the way a task fails.

Turned down: OpenRouter as an integration (its key would move when it gains agents); an account type that reads
the old Keychain item in place (two places for one key); a sign-out for gh (it would sign the builder out of their
terminal); a notice for the moved key (the builder's call); showing both scopes in the sidebar with subheads (the
app-wide half stays below the fold at 1280×720).

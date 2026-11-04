# A lost release notes file is restored, and a failure on main opens an issue

- **Date:** 2026-11-04

## Decision

`release-please.yml` runs `scripts/release/restore-release-notes.mjs` before release-please.

- When an open release PR links a `release-notes.md` that isn't on its notes branch, the script
  writes a placeholder there.
- When a merged release PR still waiting for its release links a file that is missing or still the
  placeholder, the script fails the job before release-please runs, and names the branch. Nothing
  is tagged until a person puts the notes back and reruns the workflow.
- Any answer from GitHub other than not found fails the step without writing.

`main-failures.yml` runs `scripts/report-main-failures.mjs` hourly and by hand. While the latest
run of any active workflow on main has failed, one issue titled "Workflows are failing on main"
stays open and lists them; it closes when they pass. A workflow that joins the list gets a comment,
because editing an issue notifies nobody.

- Only `success` and a failed conclusion decide. Any other conclusion gives way to the run before
  it, across the last 100 runs; a workflow with none of those is listed as having no finished run.
- Pull request runs don't count, including those from a fork's `main`.
- Only an issue authored by a bot is treated as the report: the repository is public, so anyone can
  open an issue with that title, and adopting it would silence the report.
- A workflow with no run on main isn't watched. That is `release.yml`, which runs on tags: a person
  approves each release and sees its run.
- A workflow that stops running keeps its last verdict, because the script reads only finished
  runs.

## Why

A release PR whose notes pass GitHub's 65,536-character body limit keeps them in `release-notes.md`
on a branch of their own. release-please 17 resets that branch to main and writes the file in a
second API call, and every run reads the file before it reaches that write. On 2026-11-04 the
second call failed once, with an empty error, and each later push failed with `Failed to find
file: release-notes.md`. The same call succeeded once the file was back, so nothing about the notes
caused it. Upstream's current code has the same order.

An open PR's notes are built from the commits, so the placeholder loses nothing: it differs from
any real body, and the run replaces it. It needs its two `---` lines, because release-please skips
a release PR whose body has none.

A merged PR's notes come from the file alone. A placeholder there parses, gives no release data and
makes release-please create the release with an empty body, tag it and label the PR as done, in a
run that passes. That can happen when a run writes the placeholder and then fails before replacing
it, or when the PR merges in between, so the script refuses first.

It doesn't cover a deleted notes branch, where the write fails and the step stops, or a snoozed
release PR. Both fail the run, as they did before, and the issue below reports it.

The failure ran for nine hours unseen. A failed workflow on main blocks no pull request, so nothing
brought it to anyone. An issue stays visible until the cause is gone and needs no attention while
main is green.

- **`workflow_run` instead of a schedule** was turned down: zizmor flags the trigger, and it must
  list each workflow by name.
- **A failure step in each workflow** was turned down: it repeats the same job in every file, and a
  new workflow would go unwatched until someone added it.
- **Closing the release PR** clears a stuck file by hand but leaves the next failed write just as
  stuck.
- **An issue costs a little noise in an Actions incident**: it opens and closes by itself.

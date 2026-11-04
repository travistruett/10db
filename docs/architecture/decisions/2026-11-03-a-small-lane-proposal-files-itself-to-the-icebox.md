# A small lane proposal with no risk tag files itself to the Icebox, with no Inbox card

- **Date:** 2026-11-03

## Decision

- The MCP tool `propose` decides in the same write that records the proposal (`proposalFiling`,
  `inbox/proposal-task.ts`). A **new-task** proposal is filed by 10db, with no Inbox card, when all of these hold:
  - the project's size limit is above zero;
  - its title plus body is no longer than the limit, in characters;
  - the lane declared no `riskTags` (security, auth, migration, dependency) and set no `joinsRunningBatch`;
  - its text names none of those risks (whole words: `security`, `vulnerab…`, `credential`, `secret`; `auth`,
    `authenticat…`, `authoriz…`, `oauth`, `password`; `migrat…`; `dependenc…`, `lockfile`, `package.json`). A miss on a
    harmless word costs one card; a risk filed without one costs more, so the scan errs towards the card.
- Every other proposal (a task change, a principle, a note, a risk, one over the limit, one that must join a
  running batch) raises the same proposal card as before, and a person accepts or rejects it.
- **Filing.** `fileProposalByItself` files the task through `insertTaskFromProposal` with `parkInIcebox`: the
  project's Icebox column (its first column if renamed), the areas and placement an accepted proposal gets, and marks
  the proposal `accepted` with the rationale "Filed by 10db: small and no risk tag". The task's description opens
  with "Filed by 10db without an Inbox card, proposed by the lane working on the task "…" (tsk_…)", which the task
  drawer shows. `propose` answers `{ proposalId, taskId }`; `taskId` is null when a card was raised.
- **The limit** is a per-project app setting `proposals.smallLimit.<projectId>` (no migration), default 1200
  characters (`DEFAULT_SMALL_PROPOSAL_LIMIT`), read and set through `GET/PUT /projects/:id/small-proposal-limit` and
  shown in Settings › General. Zero is a real value and sends every proposal to the Inbox as before.

## Why

On 2026-11-03 both proposal cards were accepted unchanged, as on earlier nights. Accepting only files the task to
the Icebox, which is not a lane, so the card guarded nothing the Icebox did not. A risky or large proposal, or one
that would join a running batch, can still change what runs next, so those keep the card.

## Not done

- The lane declares `riskTags` and `joinsRunningBatch` itself; 10db cannot know them. The text scan is the check
  on a lane that leaves a tag off, and it is deliberately narrow. Nothing yet moves a filed task into a running
  batch, so `joinsRunningBatch` only keeps the card.
- Size is characters of text, not the lane-time estimate Shape derives for a task, since a proposal has no
  criteria or areas to size.

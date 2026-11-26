# A Slack pictures post links the task's Linear issue and says where the work went and how it went

- **Date:** 2026-11-26
- **Amends:** `decisions/2026-11-23-a-projects-pictures-can-go-to-its-slack-channel.md` (what a post's text says)

## Decision

A finished task's post (with pictures, or with the one line saying why there are none) reads, in at most four
short lines plus its files (`delivery/slack-picture-text.ts`, facts from `delivery/slack-task-facts.ts`):

1. The project, the task's Linear issue as a link labelled with its key (`<url|AMP-84>`) when the task was made
   from one, the task's title, and where the work went, read from the run that finished the task only:
   `<url|PR #n> opened` (or `merged`) when that run's batch has a pull request that was not closed unmerged, or
   `landed on \`<branch>\`` for local delivery when the run committed something: a local copy's batch base, or
   the branch the run pinned at its start in Your folder. Otherwise it says neither.
2. The task's why, in italics, when it has one.
3. What 10db already recorded about the run that finished it: how many of the task's runs got as far as a
   session, `review approved` when its code review's latest round approved (plan review and QA don't count),
   `checks passed` or `checks failed` from the run's newest gate evidence (else its batch's gate), and the short id
   of its last commit when it committed on the branch it landed on. A lane run's work lands as another commit,
   which 10db does not keep, so its post names no commit.
   Each part is left out when it was not recorded; nothing is computed from git or guessed.
4. With no pictures, `No before and after pictures: <reason>.`, the pictures service's reason read on after the
   colon and cut to 300 characters. Otherwise the count of pictures that did not fit, as before.

A pass's post opens with the project, the pass and `<url|PR #n> opened`, lists its signed-off pages (at most
10, then `and N more`), each with its Linear issue's link when it has one, and keeps the count of pictures
left in the pull request. The link at the end ("Open the pull request") is gone: the headline carries it.

Every value is escaped for `mrkdwn`, every address is a `<url|label>` link with `|`, `<`, `>` and spaces
encoded, and no bare URL is posted. The whole text is cut to 3,000 characters after escaping, never inside a
link or an entity, so Slack never refuses a post for its length; a refused post would retry forever. A failed
read of the facts posts without them, and the daemon logs it. Only a task's own Linear link is shown; a follow-up of a linked task, which
reports to its source's issue on Linear, posts no issue link.

The posts are the same on every account kind: Slack, the database and the picture store are all they read, so a
Claude plan, Bedrock or an API key, and a ChatGPT/Codex plan post the same text.

## Why

The builder's teammates read the channel, a product person among them. "X is done" told them nothing about
which issue it was, why it mattered or where to look; the Linear issue is where they already track the work, so
it is the one link worth putting first, and the pull request is the second. The facts on the third line are
already rows 10db keeps (runs, review rounds, gate evidence, commit events), so the post costs no git call or
network read and never states something 10db did not see. A friendlier sentence for a failed sign-in ("10db
couldn't sign in to the app") was turned down for now: the pictures service hands over a free-text reason
without saying which kind of skip it was, and guessing from the words would mislabel the other kinds.

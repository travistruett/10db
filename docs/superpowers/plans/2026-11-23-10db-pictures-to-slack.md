# Pictures to Slack

## Brief

- **What changes for the builder.** A project's new Settings › Sharing page (This Project, after App Preview) holds
  Pictures in Pull Requests (moved from App Preview) and two new fields: **Post Pictures to Slack** (a switch, off
  by default) and **Slack Channel** (a searchable select of the channels in the project's Slack workspace). When a
  UI Workbench pass opens its pull request and the switch is on, @10db posts one message to the channel: the pass
  name, a one-line description, the signed-off tasks, and each signed-off page's before and after pictures (at
  most 10 files; past that the message says how many more are in the PR) and the PR link, as one message.
  The PR usually opens as a draft after the first sign-off, so the post shows the pages signed off by then; pages
  signed off later reach the PR, not the channel. A follow-on PR, or a PR reopened after a close, posts again.
  Projects that deliver locally, or have no origin, never post. Turning the switch on while a pass's PR is
  already open posts it at that PR's next push.
- **What it buys.** Partners see finished UI work in Slack without the builder screenshotting and pasting it.
- **What could go wrong, and how we'd know.** The existing bot token lacks the new scopes: the Sharing page says so
  and how to fix it (add the scopes, reinstall, Replace Token on the Slack card), and a refused post leaves one
  Inbox item with Slack's reason; the next push to the PR tries again until it posts. A private channel the bot isn't in can't be joined: the picker lists only
  private channels @10db is in and says "invite @10db". A failed post never blocks or delays the PR.
- **Calls the builder might disagree with.** Posts only when the pass's PR opens (the builder chose this). 10db
  joins a public channel by itself. Turn pictures are never posted.
- **What is needed from the builder.** Once, after merge: add the four scopes to the 10db Slack app, reinstall it,
  and Replace Token.

## Size

Feature (about 450-600 lines). One implementer end to end, one review that blocks only on bugs, one e2e extended.

## Provider parity

No model is involved: git, Slack and the picture browser only, so every account kind behaves the same.

## Parts

1. **Slack client** (`apps/daemon/src/slack/client.ts`, the only module that calls Slack): `listChannels`
   (`conversations.list`, `types=public_channel,private_channel`, `exclude_archived=true`, `limit=200`, cursor
   paging), `joinChannel` (`conversations.join`), `uploadFiles` (`files.getUploadURLExternal` per file, POST the
   bytes to `upload_url`, then one `files.completeUploadExternal` with every file, `channel_id`,
   `initial_comment`), each reply parsed with zod. Honor `Retry-After` as the client already does.
   `files.getUploadURLExternal` takes form-encoded or query arguments, not JSON (the client's `write` sends JSON):
   call it through `read` or a new form-encoded kind. The byte upload has its own path: no `Authorization`
   header, no envelope parse, under the client's timeout. Typed errors
   for `missing_scope`, `not_in_channel` and `channel_not_found`; never the token in an error.
2. **Scopes**: add `files:write`, `channels:read`, `groups:read`, `channels:join` to
   `apps/desktop/src/views/settings/sign-ins/slack-manifest.ts` and `docs/slack-app.md` (a repo test keeps them
   equal), with what each is for.
3. **Channels route**: `GET /projects/:id/slack/channels` (the project's workspace via `projectSlack`), cached
   like members, and refused to the render and dev-UI reads as `/slack/members` is (`DEV_UI_REFUSED_READS`,
   `render-access.ts`'s refused list). Answers each channel's id, name, private flag and whether
   the bot is a member, or a typed "missing scope" state the UI explains.
4. **Project setting**: stored as a project app-setting in the style of `ProjectSlackSetting` (no migration):
   `{ enabled, teamId, channelId, channelName }`, read and written through `GET`/`PUT /projects/:id/slack-sharing`;
   `rebindProjectSlack` clears the channel when the project's workspace changes. Contract in
   `packages/contracts`.
5. **The post** (`apps/daemon/src/delivery/`, a new module): `ensurePassPr` calls it whenever the pass's PR
   exists (created, found again after a restart, or pushed to) and the PR's URL isn't yet marked as posted. It is
   detached from the Ship job: `void`, its own catch and its own timeout signal, never the job's, so it never
   delays the gate or turns into the job's "Pushing … did not finish" notice. It reuses `picturePlan` and
   `signedOffTasks`, reads files from the picture store, joins a public channel when not a member, and uploads
   every picture in one `files.completeUploadExternal` whose `initial_comment` holds the pass name, the tasks and
   the PR link (one message; no thread reply, since that call returns no message `ts`). On success it writes the
   PR URL as posted under its own app-setting key, per pass (pass id to posted URL; no migration), which the
   settings route and `rebindProjectSlack` never write, so two open passes never repost each other. A pass with a
   post in flight is held in an in-memory set and a second caller skips, so a sign-off during an upload never
   posts twice. On failure it leaves one Inbox item with Slack's reason, folded per pass (`foldKey`) so retries
   never stack, and the next push retries. `PassPullRequestDeps` gains the Slack client; with Slack off
   (`TENDB_SLACK=off`, client null) it skips silently.
6. **Settings UI**: `sections.ts` adds `Sharing` (key `sharing`, Project subhead, after App Preview);
   `general-field-homes.ts` moves `prPictures` there; `project-pages-form.tsx` loses that row; a new
   `sharing-section.tsx` with the switch and a channel select modelled on `people/member-select.tsx`, disabled
   with a link to Integrations when the project has no connected workspace, and showing the missing-scope fix
   when the token lacks scopes. Notes in `apps/desktop/src/views/settings/AGENTS.md` (mind its 5000-word budget).
7. **Fake Slack** (`scripts/fake-slack.mjs`): `conversations.list` and `conversations.join` for the dev window's
   channel picker.
8. **Decision record**: `docs/architecture/decisions/2026-11-23-a-projects-pictures-can-go-to-its-slack-channel.md`,
   amending `2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md` the way
   `2026-11-12-a-pass-pull-request-can-show-before-and-after-pictures.md` does: the builder's own pictures, to a
   channel they chose, off by default; Slack is a wider audience than the repo.

## Tests

- **E2E**: the e2e daemon runs with Slack off and no pass PR can open there (no origin, no `gh`, no Keychain on
  CI's Linux image), so extend the settings flow: the Sharing page shows Pictures in Pull Requests and, with Slack
  off, the Post Pictures to Slack switch disabled with its reason.
- **Unit** (data going out, so core): one `createDeliveryHarness`-style test over a fake `fetch`: a pass PR with
  the setting on posts one upload with its pictures and the PR link and marks it posted; with the join refused,
  or the setting off, nothing is uploaded; a refused post retries on the next push.

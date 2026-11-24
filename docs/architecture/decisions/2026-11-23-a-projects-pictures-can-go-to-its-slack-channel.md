# A project's pictures can go to a Slack channel the builder chose, when the project opts in

- **Date:** 2026-11-23
- **Amends:** `decisions/2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md` (pictures
  stay on the Mac unless the project turns this on), as
  `decisions/2026-11-12-a-pass-pull-request-can-show-before-and-after-pictures.md` does for the pull request

## Decision

Settings › Sharing holds a project's **Post Pictures to Slack** switch (off by default) and **Slack Channel**,
a channel of the project's own Slack workspace (`slack-sharing.<projectId>` app setting: `enabled`, `teamId`,
`channelId`, `channelName`). With the switch on and a channel picked, when a UI Workbench pass's pull request
is open and its URL is not yet marked as posted:

- 10db makes one Slack message with every signed-off page's before and after picture (at most 10 files; the
  text says how many more are in the pull request), the pass's name, its pages and the pull request link,
  using the pictures the pull request section already plans (`delivery/pr-pictures.ts`). Turn pictures are
  never posted.
- It joins a public channel the bot is not in; a private channel it is not in is reported, not joined.
- On success it records the URL as posted for the pass (`slack-pictures-posted.<projectId>`), so a pass
  posts once per pull request; a follow-on pull request, or one reopened after a close, has another URL and
  posts again.
- The post runs detached from the Ship job with its own timeouts. A failure leaves one Inbox item with Slack's
  reason, folded per pass, and the pass's next push to the pull request tries again. It never delays or fails
  the pull request.
- Changing the project's workspace clears the channel.

Projects that deliver locally, or have no origin, never open a pull request and so never post. Only git,
Slack and the picture store are involved, so every account kind behaves the same.

## Why

Partners watch Slack, not pull requests; the builder was screenshotting pages and pasting them in. The pictures
are the builder's own, sent to a channel the builder chose, off by default. It is still a wider audience than the
repository: a picture can show the app's own data, and everyone in the channel sees it, which is why the switch
is a project setting and the Sharing page says so. The post waits for the pull request so it announces finished
work rather than every sign-off, and a thread reply was left out because the file-completion call returns no
message timestamp.

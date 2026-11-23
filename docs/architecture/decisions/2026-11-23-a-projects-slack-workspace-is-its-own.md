# A project's Slack workspace is its own, and a project sends nowhere until one is chosen

- **Date:** 2026-11-23
- **Amends:** the stakeholder questions spec (`docs/superpowers/specs/2026-11-11-10db-stakeholder-questions-design.md`)
  §5 (one Slack contact per person), §9.1 (one app in one workspace), §9.2 (one connection) and §10.1 (the Slack
  card); the sign-ins spec's "Sign-ins and bindings"
  (`docs/superpowers/specs/2026-11-21-10db-accounts-harnesses-and-sign-ins-design.md`), whose binding fell back to
  the only workspace; and `decisions/2026-11-12-stakeholder-questions-run-on-the-inbox-card.md`, whose builder's
  name is picked "when Slack connects"

## Decision

- **Several workspaces, one app each.** 10db signs in to any number of Slack workspaces. Each has its own Slack
  app, made by the builder from 10db's manifest in that workspace, and its own pasted bot token, kept in the
  Keychain under `slack-bot:<teamId>`. There is no OAuth, no distributed app and no Marketplace listing. Adding a
  workspace never removes another. A token pasted to replace one workspace's token that Slack says belongs to
  another team is refused, and nothing is stored.
- **A project names its workspace, or none.** A project sends through the one workspace it is bound to
  (`slack.<projectId>`), or through none ("Off"). No binding, or a binding to a workspace no longer signed in,
  reads as Off. A new project starts Off. There is no default workspace. When this lands, every existing project
  without a stored choice is bound explicitly to the workspace signed in then, so nothing changes on upgrade.
- **Everything a send does uses its own workspace.** A send records the team it was drafted in. Its token, its
  recipients' Slack users and DM channels, its reply watch, its reminders and closing lines are that team's.
  Each workspace has its own connection state and its own watch, so one workspace's outage neither hides nor
  stalls another's.
- **One person, a contact per workspace.** A person stays one People row and has at most one Slack contact in each
  workspace (`person_contacts` unique on person and team), each with its own send mode and daily limit. The daily
  limit and the first-send review count sends in that workspace only.
- **No reach across workspaces.** A question in a project goes to a person through their contact in the project's
  workspace, never through another. When a recipient has none there, or the project is Off, the card stays the
  builder's with **Copy for <name>**, as for anyone not on Slack. Ask Someone and the routes editor say a person
  is "not in <workspace>'s Slack" for that project.
- **Changing a project's workspace takes its questions back, in the same write.** The binding changes, its sends
  out in the old workspace (sending or sent) fail back to the builder with `workspace_changed`, and its drafts are
  drafted again for the new workspace, all in one transaction. Off keeps drafts held as `slack_off` and takes
  back what is out. A Copy For card is not asked again; the builder presses Ask Someone. A send whose team
  differs from its project's stored binding is never posted to; a send whose workspace is merely disconnected
  waits for it.
- **A new bot is a new conversation.** When a workspace's token comes from a new bot user (the app was made
  again), that workspace's DM channels and cursors are forgotten and its sending and sent sends fail back to the
  builder with `bot_changed`. A workspace with no bot on record (one stored before this, or one connected again
  after a Disconnect, which forgets the record) records its bot and forgets its DM channels, which 10db opens
  again on the next send. Threads from before the bot was recorded are never joined by a follow-up: a new
  question starts a new thread.
- **Which One Is You is per workspace, and blocks nothing.** The builder may pick their own member in each
  workspace, which fills the row's "you're @name". The first pick still names the builder. A builder still named
  "You" has drafts shown first for review; Send is never refused for it.

## Why

Projects belong to different companies, and each company's questions must reach only its own Slack. The send path
checked a yes/no per project and posted with the one stored token, so a second workspace would have replaced the
first, moved unbound projects to it, and sent the first company's contacts through the second's bot. This is a
hard limit about sending data out (`decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`):
the workspace is fixed by the project, not judged per send.

- **One app per workspace, not OAuth.** OAuth needs a client secret shipped in the app and a redirect it can
  receive, and a distributed non-Marketplace app gets Slack's cut rate limits (spec §9.1). 10db is not sold, and a
  Marketplace app is far off; a manifest and a pasted token per workspace is a minute's setup and keeps Tier 3.
  Turned down: one shared app distributed to every workspace.
- **Off until chosen.** With more than one workspace, any default can send a project's question to the wrong
  company. Binding today's projects at upgrade keeps them working; a "Use for New Projects" default can come
  later if the extra click annoys.
- **A contact per workspace, not a person per workspace.** The same human is a stakeholder in two companies'
  Slack under two user ids. Two People rows would split their routes and their answers; one row with two contacts
  keeps routes by person and reach by workspace.
- **Copy for, never another workspace.** Reaching someone through another company's Slack would carry one
  company's question into another's workspace. Copy for already covers anyone 10db can't message.
- **Taking questions back on a change.** A sent question's replies come in the old workspace, which the project
  no longer uses; reading on there would keep a conversation the builder moved away from. Returning the card is
  one visible step the builder can redo with Send.
- **A new bot invalidates DM channels and threads.** A DM is between a user and a bot; a recreated app's bot can't
  read or post in the old channel (`channel_not_found`), and before this a person had to be removed and added
  again. A follow-up joins the newest thread for the same people and task, so old threads must be out of reach
  too. Disconnect forgets the bot because the workspace entry is gone; treating a reconnect as a first record
  costs one fresh thread and never posts into a dead channel.
- **One write for a change of workspace.** A take-back after the binding's write would leave a window where a
  watch or a recovery posts in the old workspace for a project that has moved; one transaction leaves none.
- **The builder's name gate.** The name only changes how a message reads ("You's 10db build"), so it is a review
  hold, not a refusal; with several workspaces a pick in each is optional.

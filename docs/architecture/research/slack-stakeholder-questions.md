# Slack for stakeholder questions: research notes

Researched by a Claude subagent (claude-opus-5-5) for `docs/superpowers/specs/2026-11-11-10db-stakeholder-questions-design.md`.

Research date: 2026-11-11. Sources are docs.slack.dev (the current Slack developer docs; api.slack.com
pages now redirect there), slack.com help/legal pages, and the npm registry. Every fact is marked
VERIFIED (with a URL) or UNKNOWN. Quotes are verbatim excerpts from the fetched pages.

---

## 1. Transport: Socket Mode vs Events API over HTTP

### What Socket Mode is and needs

- VERIFIED: Socket Mode lets an app use the Events API and interactivity "without exposing a public
  HTTP Request URL". The WebSocket URL "is created at runtime by calling the apps.connections.open
  method, and it refreshes regularly."
  https://docs.slack.dev/apis/events-api/using-socket-mode
- VERIFIED: App-level token. "Your app-level token allows your app ... to generate a WebSocket URL for
  communication with Slack via the apps.connections.open method." Bolt example uses
  `export SLACK_APP_TOKEN='xapp-***'`. Token goes "in the Authorization header, not as a parameter."
  https://docs.slack.dev/apis/events-api/using-socket-mode
- VERIFIED: Scope `connections:write` - "Grants permission to generate websocket URIs and connect to
  Socket Mode"; token type "App-level"; "an app-level token with this scope allows your app to call
  the apps.connections.open method". https://docs.slack.dev/reference/scopes/connections.write
- VERIFIED: "Socket Mode is only available for apps using granular permissions." and "Apps using
  Socket Mode are not currently allowed in the public Slack Marketplace."
  https://docs.slack.dev/apis/events-api/using-socket-mode
- VERIFIED: No request-URL verification needed: "there's no need to verify or validate inbound events,
  because you're receiving the events over a pre-authenticated WebSocket."
  https://docs.slack.dev/apis/events-api/using-socket-mode

### Connection limits and reconnect

- VERIFIED: "Socket Mode allows your app to maintain up to 10 open WebSocket connections at the same
  time. When multiple connections are active, each payload may be sent to any of the connections."
  https://docs.slack.dev/apis/events-api/using-socket-mode
- VERIFIED: "No matter what, you'll need to handle connection refreshes once every few hours." A
  `disconnect` message with reason `warning` may arrive "about 10 seconds before the disconnect";
  also `refresh_requested` and `link_disabled` (Socket Mode toggled off). The `hello` message carries
  `approximate_connection_time` (example value 3600 s). `&debug_reconnects=true` shortens the
  connection to 360 s for testing. https://docs.slack.dev/apis/events-api/using-socket-mode
- VERIFIED: Slack's own reliability caveat: "the socket server backend recycles containers serving
  connections every now and then, leading to occasional reliability issues. To have the highest
  possible reliability ... we recommend using HTTP for production applications." But also: "As long
  as you do not intend to submit your app to the Slack Marketplace and actively maintain your
  connection to us, Socket Mode is a reliable option."
  https://docs.slack.dev/apis/events-api/comparing-http-socket-mode

### What happens to events while no socket is connected

- VERIFIED: Each Socket Mode envelope must be acknowledged with its `envelope_id`: "Your app still
  needs to acknowledge receiving each event so that Slack knows whether to retry."
  https://docs.slack.dev/apis/events-api/using-socket-mode
- VERIFIED (HTTP wording; the page does not split by transport): "If your app fails to acknowledge
  the receipt of an event, Slack will retry three times over the course of a few minutes. Enable the
  Delayed Events feature for Slack to follow those three retries with hourly retries for 24 hours.
  The Events API is a best-effort system ... By default, we will not attempt to deliver an event that
  is more than two hours late. If the delayed events feature is enabled, we will attempt to deliver
  events regardless." Toggle: app settings > Event Subscriptions > Delayed Events.
  https://docs.slack.dev/apis/events-api/#delayed-events-retry
- VERIFIED: HTTP retry schedule: "nearly immediately", "after 1 minute", "after 5 minutes".
  https://docs.slack.dev/apis/events-api/#retries
- VERIFIED: Delayed Events shipped 2026-02-05: "In case of an outage where your app may have missed
  events, we've released a Delayed Events feature that lets you replay past events."
  https://docs.slack.dev/changelog/2026/02/05/retry-events-feature
- VERIFIED: Only explicit Socket Mode loss statement: "If your app is actively receiving events when
  you toggle Socket Mode on, you may lose events until you establish a connection to your WebSocket
  URL." https://docs.slack.dev/apis/events-api/using-socket-mode
- UNKNOWN: Whether Slack queues Socket Mode events when zero sockets are connected, and whether the
  3-retry schedule and the Delayed Events 24-hour replay apply to Socket Mode (neither page says). No
  official doc states that an overnight-offline Socket Mode app gets its events later.
  Design consequence: treat events as a latency optimisation only; the source of truth after any
  offline gap must be a Web API catch-up read (section 2). Even with Delayed Events on, a laptop asleep
  for more than 24 hours loses events per the HTTP wording above.
- VERIFIED: Auto-disable rule (HTTP): subscriptions are "temporarily disabled" when failures exceed
  "95% of delivery attempts within 60 minutes", but "apps receiving less than 1,000 events per hour
  will not be automatically disabled." https://docs.slack.dev/apis/events-api/#error-handling

### Interactive payloads in Socket Mode and offline clicks

- VERIFIED: "Interactive features also send payloads as normal to your app" over the socket, with
  examples for slash commands, Block Kit buttons, App Home, modals and dynamic menus.
  https://docs.slack.dev/apis/events-api/using-socket-mode
- VERIFIED: Ack within 3 s or the user sees an error: "This must be sent within 3 seconds of
  receiving the payload. If your app doesn't do that, the Slack user who interacted with the app will
  see an error message". https://docs.slack.dev/interactivity/handling-user-interaction
- UNKNOWN: The exact error text a user sees when no socket is connected at click time, and whether
  interaction payloads are retried later (no doc describes retries for interactivity; the retry and
  Delayed Events text is in the Events API page only). Assume a click while 10db is offline is lost
  and shows an error to Mark.

### HTTP Events API for a local app

- VERIFIED: HTTP needs a public Request URL and per-request signature validation ("validation is
  required for each event"). https://docs.slack.dev/apis/events-api/using-socket-mode
  A sleeping laptop with no public URL cannot receive these without a tunnel or relay, which 10db
  does not have. Socket Mode is the only first-party transport that fits.

## 2. Catch-up after offline: reading missed replies

### Methods and scopes

- VERIFIED: `conversations.history` "Fetches a conversation's history of messages and events"; bot or
  user token with the relevant `*:history` scope (`channels:history`, `groups:history`, `im:history`,
  `mpim:history`); a bot token reaches "Any conversation the relevant bot is a member of." Supports
  `oldest`/`latest`/`inclusive`, cursor pagination; listed "Tier 3: 50+ per minute".
  https://docs.slack.dev/reference/methods/conversations.history
- VERIFIED: `conversations.replies` "Retrieve a thread of messages posted to a conversation"; same
  `*:history` scopes; takes `ts` of the parent and `oldest`; "The earliest messages in the time range
  are returned first."; "Tier 3: 50+ per minute".
  https://docs.slack.dev/reference/methods/conversations.replies
- Catch-up recipe (derived from the two pages above): for each open question persist
  `{channel (D... id), question_ts, last_seen_ts}`. On wake/reconnect call
  `conversations.replies(channel, ts=question_ts, oldest=last_seen_ts)` for in-thread answers, and
  `conversations.history(channel, oldest=last_seen_ts)` for answers Mark typed at top level of the DM.
  Filter out the bot's own messages, advance `last_seen_ts`, dedupe by `ts` against anything the
  socket already delivered. This is cheap: one or two calls per open question.

### The 2025 rate-limit change for non-Marketplace apps

- VERIFIED (2025-05-29): "This rate limit reduction will apply only to applications that are
  commercially distributed outside of the Marketplace (also called 'unlisted' apps). ... The new rate
  limits will be updated to allow 1 request per minute and will return a maximum of 15 objects per
  request." Applies "immediately, as of May 29, 2025" to "New non-Marketplace applications and new
  installations of existing non-Marketplace applications."
  https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps
- VERIFIED (same page): "Internal customer-built applications are not impacted by these changes. For
  Custom apps, the conversations.history and conversations.replies API methods are limited to 50+
  requests per minute. The maximum and default values for the limit parameter are 1,000 objects." and
  FAQ "Will my internal app be impacted? No, internal customer-built apps are not impacted and retain
  their current, higher rate limits."
- VERIFIED (2025-06-03 clarification): "Any internal customer-built apps will maintain their existing
  rate limits and will not be subject to the new posted limits."
  https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity
- VERIFIED: Same 2025-05-29 page says the updated API Terms define commercial distribution to cover
  apps that are "'unlisted' (published outside of the Marketplace) or provide a customer instructions
  for a templated custom app that connects to your product."
  https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps
- VERIFIED: The current API Terms (effective October 10, 2025) define "Commercially Distribute" as
  "any situation where your Application integrates with Slack APIs and users could pay fees for your
  product, service, or features". https://slack.com/terms-of-service/api
- VERIFIED: The 10db repo is Apache-2.0 (`LICENSE`, line 2).
- Answer: a single-workspace, undistributed app the builder creates in their own workspace is an
  internal customer-built app and keeps Tier 3 (50+/min, up to 1,000 objects). VERIFIED by the
  quotes above. Caveat: if 10db ever charges users, "instructions for a templated custom app" falls
  under Commercial Distribution per the FAQ wording, which would need Marketplace review (and Socket
  Mode is not allowed in the Marketplace).
- UNKNOWN: How Slack technically classifies an app as "internal" vs "commercially distributed" for
  rate-limit enforcement (no doc states the mechanism; likely "Public Distribution" off). Also
  UNKNOWN: a third-party claim found by search that the limits reached existing unlisted installs on
  March 3, 2026; the current official changelog page still says existing installs are not affected,
  and nothing on docs.slack.dev mentions that date. Irrelevant for an internal app either way.

## 3. Identity: bot token vs user token

### What each token is

- VERIFIED: Bot tokens (`xoxb-`) "are not tied to a user's identity; they're only tied to your app.
  Since acting independently allows your app to stay installed even when an installing user is
  deactivated, using bot tokens is usually for the best." User tokens (`xoxp-`) "represent the same
  access a user has to a workspace ... Write actions with user tokens are performed as if by the user
  themselves." https://docs.slack.dev/authentication/tokens
- VERIFIED: A single-workspace app's one-click install "generates an access token"; "if your
  single-workspace app needs to take action on behalf of other users, you'll need to build an OAuth
  2.0 flow." (The installing builder's own user token comes from the same install.)
  https://docs.slack.dev/app-management/distribution
- VERIFIED: `chat.postMessage` `as_user` is "(Legacy) ... Can only be used by classic apps." A modern
  app posts as the user simply by calling with the user token (scope `chat:write` on the user token).
  https://docs.slack.dev/reference/methods/chat.postMessage

### Trade-offs (analysis, built on the facts in this section)

|                          | Bot "10db" (`xoxb`)                                          | As the builder (`xoxp`)                                                                                                                            |
| ------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who Mark sees            | An app; clearly automated                                    | The builder; looks like a normal DM                                                                                                                |
| Reading replies          | Only the bot's own DMs/channels (`im:history` scoped to bot) | `im:history` user scope reads _every_ DM the builder has; `message.im` user event fires for all of them                                            |
| Transparency             | Honest about automation                                      | Risk of Mark not knowing an agent wrote it; Developer Policy prohibits "Allowing impersonation of Users" (https://docs.slack.dev/developer-policy) |
| Buttons/modals           | Work (interactivity goes to the app)                         | Buttons in a user-posted message: UNKNOWN whether Slack accepts interactive blocks from a user token                                               |
| Survives builder leaving | Yes (doc quote above)                                        | No                                                                                                                                                 |
| Slack Connect            | Needs a shared channel (section 4)                           | Builder's own DM reach                                                                                                                             |

Recommendation: bot token for v1. A user token buys only "looks like me", at the cost of reading
all of the builder's DMs; offer "as me" later as an opt-in with `user_optional` scopes.

### Can a bot DM someone who never opened the app?

- VERIFIED: "If you want your app's bot user to start a 1:1 conversation with another user in a
  workspace, provide the user's ID as the channel value and a direct message conversation will be
  opened if it isn't open already." and "You will receive a channel_not_found error if your app
  doesn't have permission to enter into a DM with the intended user."
  https://docs.slack.dev/reference/methods/chat.postMessage
- VERIFIED: Caveat on the same page: "If the channel parameter is set to a User ID (beginning with U),
  the message will appear in that user's direct message channel with Slack (the system user, USLACK).
  To post a message to that user's direct message channel with the app, use the DM ID (beginning with
  D) instead." So: call `conversations.open(users=U...)` first (scope `im:write`), store the `D...` id,
  post there. https://docs.slack.dev/reference/methods/conversations.open (scopes `im:write` etc.;
  "Providing only 1 ID will create a direct message.")
- VERIFIED: Mark can only reply in the bot DM if the Messages tab is on: "Your app needs the
  chat:write scope to use the Messages tab, and the im:history scope to respond to messages." and the
  app "must also subscribe to the message.im event". Manifest fields
  `features.app_home.messages_tab_enabled` and `messages_tab_read_only_enabled` ("whether or not the
  users can send messages to your app in the Messages tab").
  https://docs.slack.dev/surfaces/app-home and https://docs.slack.dev/reference/app-manifest
- VERIFIED: `message.im` "A message was posted in a direct message channel", Required Scopes
  `im:history`. https://docs.slack.dev/reference/events/message.im

### Reading the reply

- DM with the bot: VERIFIED readable via `message.im` (live) and `conversations.history` /
  `conversations.replies` with `im:history` on the bot token (pages cited in section 2).
- Thread in a channel: VERIFIED `thread_ts` makes a post a threaded reply
  (https://docs.slack.dev/reference/methods/chat.postMessage); reading needs `channels:history`
  (public) or `groups:history` (private) and the bot must be a member ("Any conversation the relevant
  bot is a member of", conversations.history page). Live delivery needs `message.channels` /
  `message.groups`, which deliver every message in every channel the bot is in, not only the thread.
  An alternative is `app_mention` (`app_mentions:read`), which only fires when someone @-mentions the
  bot (example manifest in https://docs.slack.dev/apis/events-api/using-socket-mode) but would miss a
  plain thread reply. Recommendation: DM first; channel threads as a later option, using
  `message.channels` plus a filter on `thread_ts` of questions we asked.

### Mapping "Mark" to a Slack user ID

- VERIFIED: `users.lookupByEmail` needs `users:read.email`; `email` argument is "An email address
  belonging to a user in the workspace". https://docs.slack.dev/reference/methods/users.lookupByEmail
- VERIFIED: "This scope must be requested at the same time as users:read."
  https://docs.slack.dev/reference/scopes/users.read.email
- VERIFIED: "Both the users:read.email and users:read OAuth scopes are required to access the email
  field in user objects returned by the users.info and users.list API methods."
  https://docs.slack.dev/apis/slack-connect/
- Minimal and sane: builder picks the person once from a searchable list (`users.list`, `users:read`)
  or types an email (`users.lookupByEmail`), 10db stores the `U...` id on the stakeholder record and
  never re-resolves by name. Emails help disambiguate two "Mark"s. Both scopes are cheap; email can be
  marked optional (`bot_optional`, section 5).
- UNKNOWN: whether `users.lookupByEmail` finds Slack Connect (external) users; the doc says "a user in
  the workspace", so assume not and use pick-from-list or paste-a-member-ID for external people.

## 4. Slack Connect and external users

- VERIFIED: "Bot users can DM all local users in the workspace they are installed in and external
  users with a common shared channel." https://docs.slack.dev/apis/slack-connect/
- VERIFIED: "Bot users are accessible to all users on the workspace where your app is installed, and
  any external members in a channel between organizations where your bot is also present."
  https://docs.slack.dev/apis/slack-connect/
- VERIFIED: "Strangers are external members on the other team that your application does not have a
  shared channel in common"; detect externals implicitly via `is_stranger` plus `team_id` ("there is
  no single property"). https://docs.slack.dev/apis/slack-connect/
- VERIFIED: "Slash commands and message actions are not shared"; "Handle action invocation by users
  from other teams, and let them know if an action is not permissible due to their external nature."
  https://docs.slack.dev/apis/slack-connect/
- VERIFIED: files in Slack Connect channels arrive with `"file_access": "check_file_info"` and "Some
  file extensions cannot be uploaded to Slack Connect channels."
  https://docs.slack.dev/apis/slack-connect/
- VERIFIED: "Slack Connect channels are not available to all free workspaces."
  https://docs.slack.dev/apis/slack-connect/
- Practical rule: to reach an external Mark, the bot must be in a shared channel Mark is also in
  (the builder invites the bot to that Slack Connect channel). Then either DM Mark (allowed by the
  quote above) or ask in a thread in that shared channel.
- UNKNOWN: whether the external org's own admin policies can block DMs from another org's bot, and
  the exact error returned. UNKNOWN: whether a user token can open a Slack Connect DM with an external
  person via `conversations.open`. Test in the builder's real workspace before promising this.

## 5. Installation, manifest, approval, token rotation, distribution

### Manifest facts used below

- VERIFIED field list (https://docs.slack.dev/reference/app-manifest):
  `settings.socket_mode_enabled`, `settings.token_rotation_enabled`,
  `settings.app_level_token_rotation_enabled`, `settings.org_deploy_enabled`,
  `settings.interactivity.is_enabled` ("Required (if using interactivity settings)";
  `request_url` optional), `settings.event_subscriptions.bot_events` (max 100),
  `features.app_home.messages_tab_enabled`, `features.app_home.messages_tab_read_only_enabled`,
  `features.bot_user.display_name` / `always_online`, `oauth_config.scopes.bot`,
  `oauth_config.scopes.bot_optional` ("Optional scopes must also be listed in the corresponding bot
  fields"). `display_information.description` max 140 chars.
- VERIFIED: Optional scopes shipped 2026-03-16: "Users now see optional scopes presented separately
  during installation and can choose which ones to grant."
  https://docs.slack.dev/changelog/2026/03/16/optional-scopes
- VERIFIED: The Socket Mode guide's own manifest example uses `socket_mode_enabled: true`,
  `org_deploy_enabled: false`, `is_hosted: false`, `token_rotation_enabled: false`.
  https://docs.slack.dev/apis/events-api/using-socket-mode
- VERIFIED: The app-level token is not in the manifest; it is generated in the UI: "Under Basic
  Information, scroll to the App-level tokens section and click the button to generate an app-level
  token." https://docs.slack.dev/apis/events-api/using-socket-mode
- UNKNOWN: a manifest field for the Delayed Events toggle (none listed in the manifest reference; it is
  a UI toggle under Event Subscriptions per https://docs.slack.dev/apis/events-api/).

### Example manifest (DM questions, thread replies, buttons/modals, screenshots, reading replies, user lookup)

Scope-to-need mapping, each scope's requirement verified on the method/event pages cited above:
`chat:write` (post/update), `im:write` (conversations.open), `im:history` (message.im + read the DM),
`users:read` + `users:read.email` (pick or look up Mark), `files:write` (screenshot upload). The
channel-thread mode adds `channels:history`, `groups:history`, `app_mentions:read`, marked optional.

```yaml
_metadata:
  major_version: 2
display_information:
  name: 10db
  description: Asks you questions on behalf of a builder's 10db factory and waits for your answer.
  background_color: '#1f2937'
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false # false = people CAN type replies to the bot
  bot_user:
    display_name: 10db
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:write
      - im:history
      - users:read
      - users:read.email
      - files:write
      - channels:history
      - groups:history
      - app_mentions:read
    bot_optional: # must also appear in `bot` above
      - users:read.email
      - channels:history
      - groups:history
      - app_mentions:read
settings:
  event_subscriptions:
    bot_events:
      - message.im
      - message.channels # needs channels:history; only for the channel-thread mode
      - message.groups # needs groups:history; private channels
      - app_mention
  interactivity:
    is_enabled: true # no request_url: payloads arrive over the socket
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

A DM-only v1 drops the last three bot scopes, the `bot_optional` block (except `users:read.email` if
wanted), and the last three events. UNKNOWN: whether Slack rejects a bot event in the manifest whose
scope is only optional at install time; if the import errors, drop the optional block and the channel
events for v1.

### Can a non-admin install it?

- VERIFIED: "By default, any member can install an app ... Only allow apps from the Slack Marketplace
  ... This will not prevent members from creating and installing internal apps."
  https://slack.com/help/articles/1500009181142
- VERIFIED: With app approval on, "members can install and start using pre-approved apps right away";
  owners can "Allow members to request apps for approval"; "When approving a request to install an
  app, you are approving the scopes it will use". Enterprise: "app approval will automatically be
  enabled for your workspace if an Org Owner has set an app management policy".
  https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace
- VERIFIED: "Some workspaces will restrict app installation so that only workspace administrators can
  provide authorization." https://docs.slack.dev/app-management/distribution
- So: default workspace, a member installs directly. Approval-enabled workspace, the member submits a
  request and an owner/app manager approves the listed scopes. Fewer scopes means an easier approval;
  that argues for the DM-only v1 scope set.

### Token rotation

- VERIFIED: "Without token rotation, the access token never expires. With token rotation, it expires
  every 12 hours." "Token rotation may not be turned off once it's turned on." Refresh uses
  `oauth.v2.access` with `grant_type=refresh_token`; app-level tokens need "your app's client
  credentials". "The previous token stops working as soon as it is redeemed". "2 active token limit".
  https://docs.slack.dev/authentication/using-token-rotation
- VERIFIED (PKCE, GA 2026-03-30): "Desktop redirects (custom URI schemes and localhost redirects for
  PKCE-enabled apps) cannot request bot scopes." and "All refresh tokens issued to PKCE-enabled apps
  expire after 30 days." "Enabling PKCE ... is a one-way operation".
  https://docs.slack.dev/changelog/2026/03/30/pkce
- Implication (analysis): with rotation on, a laptop asleep for more than 12 hours wakes with an
  expired access token and must refresh with the client secret stored locally, single-use refresh
  tokens and races between refreshers. With rotation off, `xoxb`/`xapp` never expire and are revoked
  by reinstall or uninstall. For a local, single-user app, leave rotation off and protect the tokens
  in the Keychain. PKCE does not help here because desktop redirects cannot get bot scopes.
- UNKNOWN: whether a refresh token still works after its access token has expired (the doc does not
  give a refresh-token lifetime for non-PKCE apps).

### Distribution path

- VERIFIED: "When you create a Slack app, it resides in one workspace." "Undistributed apps exist on
  a single workspace and can use the full range of app capabilities, but they can't be distributed to
  other workspaces." "The one-click install for an unlisted single-workspace app generates an access
  token". Public distribution is a separate opt-in ("Click Activate Public Distribution").
  https://docs.slack.dev/app-management/distribution
- So: each builder creates their own app from the manifest in their own workspace and never touches
  Manage Distribution. That keeps it an internal app (section 2 rate limits) and avoids any OAuth
  server.

## 6. Interactivity: buttons, modals, thread replies, and offline clicks

- VERIFIED: Block Kit buttons arrive over the socket as `"type": "interactive"` envelopes with a
  `block_actions` payload incl. `response_url` and `trigger_id`; the app replies with the
  `envelope_id`. https://docs.slack.dev/apis/events-api/using-socket-mode
- VERIFIED: Ack "within 3 seconds of receiving the payload. If your app doesn't do that, the Slack
  user who interacted with the app will see an error message".
  https://docs.slack.dev/interactivity/handling-user-interaction
- VERIFIED: `response_url` "responses can be sent up to 5 times within 30 minutes of receiving the
  payload"; "If your app needs more than 30 minutes to respond with a message, you'll need to publish
  it in the standard way". https://docs.slack.dev/interactivity/handling-user-interaction
- VERIFIED: "A trigger_id will expire 3 seconds after it's sent to your app"; a modal needs a valid
  trigger_id from an interaction. https://docs.slack.dev/surfaces/modals
- Reliability ranking when 10db may be asleep at click time (analysis from the facts above and
  section 1):
  1. **Typed reply in the DM or thread: most reliable.** It is stored as a message, so
     `conversations.history`/`replies` recovers it after any offline gap regardless of event delivery.
  2. **Buttons (A/B/C): fine when online, lossy when offline.** The click needs a live socket within
     3 s; a click is not a stored message, so history cannot recover it. Retry of interaction
     payloads is UNKNOWN (section 1).
  3. **Modal: least reliable.** It needs two live round trips (button click, then `views.open`
     within 3 s, then `view_submission` ack); any of them fails when offline.
- Design that degrades well: post the question with A/B/C buttons _and_ a line "or reply in this
  thread". On a click, ack immediately, then `chat.update` the question to show "Answered: B" (with
  `chat:write`, using the bot token, not the 30-minute `response_url`). For long answers prefer
  "reply in thread" over a modal. On wake, catch up from history; buttons Mark clicked while 10db
  slept are lost, and Mark has seen an error, so he will likely type the answer instead.

## 7. Node SDKs

- VERIFIED (npm registry, `npm view`, 2026-11-11): `@slack/bolt` latest **5.1.0** (published
  2026-09-02, `engines.node >=20`); `@slack/socket-mode` latest **3.2.0** (published
  2026-11-10T16:37Z); `@slack/web-api` latest **8.3.0** (published 2026-10-30); `@slack/types`
  **3.3.0**. Bolt 5.1.0 depends on `@slack/web-api ^8.1.1`, `@slack/socket-mode ^3.0.1`, `express
^5.0.0`. https://www.npmjs.com/package/@slack/bolt , https://www.npmjs.com/package/@slack/socket-mode ,
  https://www.npmjs.com/package/@slack/web-api
- VERIFIED maintenance: Bolt for JS v5 released 2026-07-15 ("follows the Node Slack SDK's shift from
  axios to the native Fetch API ... raises the minimum Node.js version to 20"; "We've added a
  dispatcher option to the SocketModeReceiver class").
  https://docs.slack.dev/changelog/2026/07/15/bolt-js-release . Node SDK majors 2026-07-14
  (`socket-mode` v3, `web-api` v8). https://docs.slack.dev/changelog/2026/07/14/node-slack-sdk-release .
  Socket Mode v3.1.0 "pins the WebSocket connection to HTTP/1.1".
  https://docs.slack.dev/changelog/2026/09/30/node-sdk . Actively maintained.
- Note for 10db's exact-pin rule: socket-mode 3.2.0 is one day old; 3.1.1 (2026-10-30) is the prior
  stable. Pick per the repo's "latest stable when added" rule.
- VERIFIED: Bolt in Socket Mode starts no HTTP server unless OAuth or custom routes are configured:
  `SocketModeReceiver.js` line 75 `if (this.installer !== undefined || customRoutes.length) {` then
  line 78 `createServer(...)` (package `@slack/bolt@5.1.0`, `dist/receivers/SocketModeReceiver.js`).
- VERIFIED: Bolt requires `appToken` with `socketMode: true` and does not require `signingSecret`
  then; the signing-secret check applies only to the default HTTPReceiver
  (`@slack/bolt@5.1.0` `dist/App.js` lines 687-708). Also: "You cannot supply a custom receiver when
  socketMode is set to true" unless it is a `SocketModeReceiver` (`dist/App.js` line 682-683).
- VERIFIED test seams:
  - `WebClientOptions` has `slackApiUrl?: string` and `fetch?: FetchFunction` ("A custom fetch
    implementation conforming to the WHATWG Fetch standard"), plus `retryConfig`, `timeout`,
    `rejectRateLimitedCalls` (`@slack/web-api@8.3.0` `dist/WebClient.d.ts` lines 15-26, 134).
  - Bolt `AppOptions` has `receiver?: Receiver`, `clientOptions?: WebClientOptions`,
    `tokenVerificationEnabled?: boolean` (it calls `auth.test` at start when true), `deferInitialization`
    (`dist/App.d.ts` lines 13-49). `Receiver` is `{ init(app), start(), stop() }` and the app exposes
    `processEvent(event: ReceiverEvent)` (`dist/types/receiver.d.ts` lines 4-15; `dist/App.d.ts`
    line 211).
  - `SocketModeClient` extends `EventEmitter`; constructor takes `appToken`, `clientOptions`,
    `autoReconnectEnabled`, `clientPingTimeout`, `serverPingTimeout`, `dispatcher`; has `start()` and
    `disconnect()` (`@slack/socket-mode@3.2.0` `dist/src/SocketModeClient.d.ts` lines 11, 65-76).
- How the daemon would test it (recommendation, fits `.claude/rules/testing.md` "mocks only at
  boundaries"): define a small port in the daemon (`postQuestion`, `fetchRepliesSince`,
  `onInbound`). Production wires `WebClient` + `SocketModeClient` (or Bolt). Tests either pass a
  `WebClient` with `slackApiUrl` pointing at a local fake HTTP server (real HTTP, network boundary
  faked) or a `fetch` stub, and drive inbound traffic by calling the same handler the socket listener
  calls (or `app.processEvent(...)` with a test `Receiver` when not in socketMode). With Bolt, set
  `tokenVerificationEnabled: false` or let the fake answer `auth.test`. The daemon needs little of
  Bolt (no HTTP, no OAuth, no slash commands), so `@slack/socket-mode` + `@slack/web-api` directly is
  a smaller dependency than Bolt and drops Express from the tree.

## 8. Files: uploading a screenshot

- VERIFIED: "The files.upload API method has been deprecated. It will stop functioning and be
  officially sunset on November 12, 2025." https://docs.slack.dev/reference/methods/files.upload
- VERIFIED flow: `files.getUploadURLExternal` (required `length`, `filename`; optional `alt_txt`)
  "returns an upload URL and a file ID"; POST the bytes to that URL; then
  `files.completeUploadExternal` with `files` (ids + titles) and optional `channel_id`, `thread_ts`
  ("upload this file as a reply. Never use a reply's ts value; use its parent instead"),
  `initial_comment`, `blocks`. "If the channel_id is not specified, the file will remain private." "If
  this method is not called, the uploaded file and associated metadata will be discarded." Both need
  `files:write`; Tier 4.
  https://docs.slack.dev/reference/methods/files.getUploadURLExternal ,
  https://docs.slack.dev/reference/methods/files.completeUploadExternal
- VERIFIED: `files:read` is only for reading (`files.info`, `files.list`, downloading
  `url_private`). https://docs.slack.dev/messaging/working-with-files
- VERIFIED: `WebClient.filesUploadV2(options)` exists in `@slack/web-api@8.3.0`
  (`dist/WebClient.d.ts` line 203) and wraps this flow.
- For 10db: upload into the bot DM `D...` with `thread_ts` = question ts. Add `files:read` only if 10db
  must download screenshots Mark sends back.

## 9. Newer things: MCP server, agents, Real-time Search, and the terms on LLMs

### Slack MCP server (announced 2026-02-17)

- VERIFIED: "The MCP server enables AI agents to interact with Slack content through tools designed
  for LLM-driven discovery". https://docs.slack.dev/changelog/2026/02/17/slack-mcp
- VERIFIED: Endpoint `https://mcp.slack.com/mcp`; tools include search, "Send messages", "Read
  threads", file upload (`slack_get_file_upload_url`, `slack_complete_file_upload`). "MCP clients must
  be backed by a registered Slack app with a fixed app ID". "Only apps published in the Slack
  Marketplace and internal apps can use MCP at this time; unlisted apps are prohibited". Auth is
  "confidential OAuth ... You'll need to use your app's client_id and client_secret"; endpoints are for
  "Slack user tokens" (`oauth/v2_user/authorize`, `oauth.v2.user.access`). Same rate limits as the Web
  API. https://docs.slack.dev/ai/slack-mcp-server
- Effect on the recommendation: none for the async loop. The MCP server acts as a user via user
  tokens and is request/response only; it has no push of Mark's reply, so the daemon still needs
  Socket Mode plus history catch-up. It could later let a managed Claude Code session _read_ Slack
  context on demand, as a separate feature with its own consent.

### Real-time Search API

- VERIFIED: "The Data Access API has evolved into the Real-time Search API"; `assistant.search.context`
  moved to `search:read.*` scopes. https://docs.slack.dev/changelog/2026/02/17/slack-mcp
- VERIFIED: "The RTS API is available for directory-published apps and internal apps only." Bot-token
  calls require an `action_token` from a message or `app_mention` event.
  https://docs.slack.dev/apis/web-api/real-time-search-api
- Effect: not needed; 10db knows the exact channel and ts of each question, so `conversations.*` is
  the precise tool.

### Agents & AI apps (assistant threads)

- VERIFIED: "New apps can only use the Agent messaging experience" (`agent_view`); "assistant_view
  will eventually be deprecated". https://docs.slack.dev/changelog/2026/06/30/agent-messages-tab
- VERIFIED: "The Assistant messaging experience (assistant_view) will be deprecated in February 2027"
  and is replaced by the "Agent Sessions API". https://docs.slack.dev/changelog/2026/08/20/agent-updates
- Effect: these features are for a user chatting _with_ an agent inside Slack. 10db's flow (agent asks
  a human, human answers later) is a plain bot DM. Do not enable `agent_view`/`assistant_view` in v1.
  It adds surfaces and events without helping the ask-and-wait loop.

### Terms: feeding Slack data to an LLM

- VERIFIED (Developer Policy, effective December 10, 2024, "Use of Data"): applications and developers
  are prohibited from "Using Data to train an LLM under any circumstances". Also "Allowing
  impersonation of Users", and "Data must be stored and served using strong encryption."
  https://docs.slack.dev/developer-policy
- VERIFIED (API Terms, effective October 10, 2025, "Data Usage by Third Parties"): "As the provider of
  an Application offered for use outside your organization, you may not: (A) use API Data to train a
  large language model; (B) bulk export Slack message and file data ...; or (C) use data collected
  from one organization to directly benefit a different organization". https://slack.com/terms-of-service/api
- VERIFIED: the 2025-10-13 terms update says the distribution section "has always only applied to
  applications distributed beyond your organization (i.e., third-party apps, not custom internal
  ones)". https://docs.slack.dev/changelog/2025/10/13/api-terms-update
- VERIFIED (RTS/Data Access terms): "you may not create persistent copies, archives, indexes, or
  long-term data stores of other organizations' API Data". Applies to those APIs used as a third party.
  https://slack.com/terms-of-service/api
- Reading: no Slack term found forbids passing a reply into an LLM prompt at inference time. The
  prohibitions are on _training_, bulk export and cross-org use. 10db must not train on replies, and
  should keep only the question/answer pair it needs, not mirror the DM.
- UNKNOWN: whether the model provider 10db uses trains on prompt data. That is the provider's terms,
  not Slack's; check it separately against the "under any circumstances" wording.

## 10. Security

- Token storage: VERIFIED "Store the refresh token as you would an access token, in a database or
  secure datastore (not in code)." https://docs.slack.dev/authentication/using-token-rotation .
  Recommendation: keep `xoxb-` and `xapp-` in the macOS Keychain. 10db already has one
  (`systemKeychain` at `apps/daemon/src/environment/keychain.ts:195`,
  wired in `apps/daemon/src/main.ts:171-173`). The UI sends secrets to the daemon, which writes them
  (`apps/desktop/src/daemon/account-secret.ts:5`). Never in SQLite, env files or logs. Validate the
  shape with zod at the boundary (`xoxb-` / `xapp-` prefixes, VERIFIED at
  https://docs.slack.dev/authentication/tokens).
- Signing secret: VERIFIED not needed in Socket Mode ("no need to verify or validate inbound events,
  because you're receiving the events over a pre-authenticated WebSocket").
  https://docs.slack.dev/apis/events-api/using-socket-mode . Bolt does not demand it in socketMode
  (section 7). The client secret is also unnecessary (no OAuth flow, no rotation).
- Least privilege: VERIFIED Developer Policy prohibits "Requesting and using scopes not required for
  your Application's functioning". https://docs.slack.dev/developer-policy . DM-only v1 needs
  `chat:write, im:write, im:history, users:read, files:write` (+ `users:read.email` if lookup by
  email). No user scopes. No `chat:write.public`, no `chat:write.customize` (impersonation scope,
  VERIFIED "only available when an app has requested and been granted an additional scope —
  chat:write.customize", https://docs.slack.dev/reference/methods/chat.postMessage).
- The `xapp-` token: VERIFIED it represents "your app across organizations"
  (https://docs.slack.dev/authentication/tokens); give it only `connections:write`.
- Stakeholder replies are untrusted input (recommendation):
  - Accept a reply only if `channel` equals the stored `D...` id (or the stored thread), `user` equals
    the stored stakeholder `U...` id, the message is not from a bot, and `thread_ts`/time is after the
    question. In shared channels anyone can post in the thread. Slack Connect externals are another org.
  - Put the reply into the agent's context as quoted data with provenance ("Mark (U123) replied in
    Slack at <time>:"), never as instructions; cap its length; strip or escape Slack mrkdwn and links.
  - Never let a reply grant permissions, change trust, approve merges or alter 10db settings by
    itself. Route anything that looks like an instruction to act through the builder, or at least show
    the builder the raw reply before the run resumes.
  - Button `value`s come back from Slack: validate them with zod against the option ids 10db issued
    for that question and check the clicking `user.id` is the stakeholder.
  - Log message ids and timestamps, not message bodies.

---

## Recommended setup

- **Transport:** Socket Mode (`@slack/socket-mode` + `@slack/web-api`, or Bolt 5 in socketMode).
  Events are an optimisation; **truth comes from a catch-up read on every (re)connect and wake**:
  `conversations.replies` + `conversations.history` since `last_seen_ts` per open question. Turn on
  **Delayed Events** in Event Subscriptions anyway (cheap). It may help, though its effect on
  Socket Mode is UNKNOWN.
- **Identity:** Bot token (`xoxb`) posting as "10db" in a DM opened with `conversations.open`. No user
  token in v1.
- **Answer UX:** Question message = context + A/B/C buttons + "or reply in this thread". Typed thread
  or DM replies are the reliable path; buttons are a fast path when online; no modals in v1.
- **Scopes (bot, DM-only v1):** `chat:write`, `im:write`, `im:history`, `users:read`,
  `users:read.email`, `files:write`. Event: `message.im`. Interactivity on. Messages tab on and
  writable. App-level token scope: `connections:write`.
- **Rotation off, distribution off, org deploy off.** Tokens in the Keychain.
- **Stakeholder mapping:** pick from `users.list` or look up by email once, store `U...` id. External
  stakeholders only through a Slack Connect channel the bot has been added to.

DM-only v1 manifest:

```yaml
_metadata:
  major_version: 2
display_information:
  name: 10db
  description: Asks you questions on behalf of a builder's 10db factory and waits for your answer.
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: 10db
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:write
      - im:history
      - users:read
      - users:read.email
      - files:write
settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

## What the builder clicks at api.slack.com

1. Go to https://api.slack.com/apps and click **Create New App**, then **From a manifest**.
2. Pick the workspace where Mark is (or where the Slack Connect channel with Mark lives). Paste the
   YAML above, review, and click **Create**.
3. **Basic Information**, then **App-Level Tokens**: click **Generate Token and Scopes**, name it
   `10db-socket`, add scope `connections:write`, and click **Generate**. Copy the `xapp-...` token.
   (Socket Mode is already on from the manifest. Check **Socket Mode** in the sidebar shows it
   enabled.)
4. **Event Subscriptions**: confirm `message.im` is listed under bot events, and toggle **Delayed
   Events** on.
5. (Optional) **Basic Information**, then **Display Information**: upload an icon so Mark recognises it.
6. **Install App** (or **OAuth & Permissions**): click **Install to Workspace** and **Allow**. If the
   workspace requires approval, the button is a request instead. Wait for an owner/app manager to
   approve, then return and install.
7. **OAuth & Permissions**: copy the **Bot User OAuth Token** (`xoxb-...`).
8. In 10db Settings, paste both tokens (10db stores them in the Keychain), then pick Mark from the
   member list.
9. In Slack, open the 10db app once under Apps and check the Messages tab accepts typing. For an
   external Mark: in the shared Slack Connect channel, type `/invite @10db` (or add it via the
   channel's Integrations tab) so the bot shares a channel with him.
10. Do **not** open **Manage Distribution**. Leave **Token Rotation** off.

The UI labels in steps 3, 6 and 7 come from the Socket Mode guide ("Under Basic Information, scroll to
the App-level tokens section"), the token-rotation guide and the distribution guide. The exact button
text for the approval request and the `/invite` path for a bot in a Slack Connect channel are
UNKNOWN; check them against the live UI when writing the in-app guide.

## 11. Group DMs and reactions (added for the builder's calls of 2026-11-12, checked the same day)

The builder decided that a stakeholder can bring a colleague into a question, that a tie asks everyone matched
together, and that a recipient approves the "Sounds like B" line with a ✅ (spec S13, S14, §8.4–§8.6). The slice-1
app therefore adds `mpim:write`, `mpim:history`, `reactions:read`, `reactions:write` and the `message.mpim` event to the DM-only
manifest above (`docs/slack-app.md` holds the current one).

What this relies on, all from Slack's method pages and **unverified until the builder pastes the results of
`docs/slack-app.md` section 3, steps 8–11, below**:

- `conversations.open` with `users` holding two to eight comma-separated member ids opens (or reopens) a group
  DM that includes the bot, and needs `mpim:write`. The builder's first run returned an id starting `C`; 10db
  assumes no prefix.
  https://docs.slack.dev/reference/methods/conversations.open
- `conversations.replies` on a group DM thread, with `mpim:history`, returns every participant's thread reply
  with its own `user`, as it does in a DM.
- `reactions.add` with `channel`, `timestamp` and `name`, with `reactions:write`, adds the bot's own reaction;
  10db seeds the ✅ on its proposal so the recipient only clicks it, and ignores the bot's id when reading it.
  https://docs.slack.dev/reference/methods/reactions.add
- `reactions.get` with `channel` and `timestamp`, with `reactions:read`, lists a message's reactions with the
  ids of the users who added each. https://docs.slack.dev/reference/methods/reactions.get
- Checked: `conversations.replies` carries a `reactions` array on each message, with the users who added each.
  The reply watch reads the ✅ from the replies it already fetches; `reactions.get` isn't needed per tick.
- UNKNOWN: what Slack does when a member mentions, in a one-to-one bot DM, someone who isn't in it. 10db reads
  the `<@U…>` in the message text either way; the check doesn't cover the mention itself, which the live
  acceptance does.

### The builder's check results

Run on 2026-11-12 in the builder's own workspace, with the app installed from the manifest by a member (no admin
approval was needed), and the bot token read from the Keychain item 10db will use (service `10db`, account
`slack-bot`). Ids are left out.

| Step | Call                                             | Result                                                                                                                                                                              |
| ---- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `auth.test`                                      | `ok`, the workspace and the bot user                                                                                                                                                |
| 3    | `conversations.open` with one member             | `ok`; the DM already existed (`already_open: true`) once the builder had opened the app                                                                                             |
| 4–5  | `chat.postMessage`, then `conversations.replies` | `ok`; the thread reply came back with the member's `user` and the question's `thread_ts`                                                                                            |
| 6    | `conversations.history` from the question's `ts` | `ok`; top-level messages came back with no `thread_ts`. The builder also typed a letter at the top level by mistake, which is the case §8.3's top-level rule handles                |
| 8    | `conversations.open` with two members            | `ok`; a group DM whose id starts `C`                                                                                                                                                |
| 9–10 | `chat.postMessage`, then `conversations.replies` | `ok`; the builder's thread reply came back with their `user`. The second member was unavailable, so a second participant's reply is still unverified; the live acceptance covers it |
| 11   | ✅ on the bot's message, then `reactions.get`    | `ok`; `white_check_mark` with the builder's id. The same array was already on the parent in step 10's `conversations.replies`                                                       |
| 7    | `users.list`                                     | `ok`; every member had `real_name` and `email`, and none had a `title` set, so the People picker can't rely on titles                                                               |

Not run: `reactions.add` (the `reactions:write` scope was added to the manifest after the app was installed;
the build reinstalls the app when it reaches Task 8f).

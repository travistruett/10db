# Setting up Slack for stakeholder questions

**Status:** built (`docs/superpowers/specs/2026-11-11-10db-stakeholder-questions-design.md`). Settings ›
People in 10db walks you through these steps and copies the manifest for you. The research behind each
choice, with sources, is `docs/architecture/research/slack-stakeholder-questions.md`.

10db asks a stakeholder in Slack through a small Slack app that you make in your own workspace from a
manifest. It is never published or distributed: it lives only in that workspace, posts as "10db" in a direct
message (or a group DM, when your stakeholder brings a colleague in or two people answer the same kind of
question), and reads only the conversations it is in. Nothing is hosted anywhere: 10db reads replies over
Slack's API from your Mac.

## What you need

- A Slack account in the same workspace as your stakeholders. Someone in another organisation is a later 10db
  (see "A stakeholder outside your workspace" below).
- Permission to install apps there. By default any member can install an internal app. If your workspace
  requires approval, Slack sends a request to an admin when you press Install; the scopes they approve are the
  nine below.
- For the group DM check, a colleague willing to reply "test" in Slack (or a second account of your own).

## 1. Make the app (5 minutes)

1. Open <https://api.slack.com/apps> and press **Create New App**, then **From a manifest**.
2. Pick the workspace where your stakeholder is.
3. Choose YAML, replace the example with the manifest below, press **Next**, check the summary, and press
   **Create**.

```yaml
_metadata:
  major_version: 2
display_information:
  name: 10db
  description: Asks you questions for a builder's 10db projects and waits for your answer.
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
      - mpim:write
      - mpim:history
      - reactions:read
      - reactions:write
      - users:read
      - users:read.email
settings:
  event_subscriptions:
    bot_events:
      - message.im
      - message.mpim
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

What each part is for:

| Part                                                   | Why                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat:write`                                           | post the question and the closing line                                                                                                                                                                                                      |
| `im:write`                                             | open the DM with your stakeholder                                                                                                                                                                                                           |
| `im:history`                                           | read their reply in that DM                                                                                                                                                                                                                 |
| `mpim:write`, `mpim:history`                           | open a group DM when your stakeholder mentions a colleague, or when two people answer the same kind of question, and read the replies there                                                                                                 |
| `reactions:read`                                       | read the ✅ your stakeholder puts on "Sounds like B… ✅ to approve"                                                                                                                                                                         |
| `reactions:write`                                      | add the ✅ to that line itself, so your stakeholder clicks the ✅ already there instead of searching for the emoji                                                                                                                          |
| `users:read`, `users:read.email`                       | pick your stakeholder from the workspace's members, searching by name, title or email, and name a colleague they bring in                                                                                                                   |
| `messages_tab_enabled`, not read-only                  | lets your stakeholder type a reply to the bot                                                                                                                                                                                               |
| `message.im`, `message.mpim` and `socket_mode_enabled` | Slack wants an event subscription for the Messages tab to accept replies, and Socket Mode is how a laptop receives one with no public URL. A later 10db uses it to pick up replies within seconds; the first one reads replies from history |
| `token_rotation_enabled: false`                        | a rotating token expires every 12 hours, so a Mac asleep overnight would wake with a dead one. Rotation can't be turned off once on                                                                                                         |
| `interactivity: false`                                 | no buttons yet. A button pressed while your Mac is asleep fails with an error in Slack; a typed reply never does                                                                                                                            |

Later 10db releases add `files:write` (screenshots) and buttons. Adding a scope after you installed the app,
including one this guide added since you made it (such as `reactions:write`), means reinstalling it: one click on
the same page (**Install App › Reinstall to Workspace**).

4. Optional: under **Basic Information › Display Information**, upload an icon so your stakeholder
   recognises the bot: [`slack-app-icon.png`](slack-app-icon.png) (1024 × 1024), with the background color
   `#1F262A`.

## 2. Install it

1. In the sidebar, open **Install App** and press **Install to Workspace**, then **Allow**.
   - If your workspace needs approval, the button sends a request instead. Come back once an admin approves
     it and install.
2. Copy the **Bot User OAuth Token**. It starts `xoxb-`. Treat it as a password: 10db keeps it in your
   Keychain, and you never need to paste it anywhere else.

Never open **Manage Distribution**. An app that stays in one workspace is an internal app, which keeps Slack's
normal rate limits for reading replies.

## 3. Check it before the build (15 minutes, required)

This checks, in your own workspace, what Slack's documentation doesn't settle and the build relies on: that a DM
from the bot accepts a typed reply, that the reply can be read back in its thread and at the top of the DM, what
the member list returns, that the bot can open a group DM and read two people's replies in it, and how a ✅
reaction reads back. You play the stakeholder; a colleague (or your second account) plays the person brought in.

```sh
# Paste the token when asked; it stays out of your shell history.
read -rs SLACK_BOT_TOKEN && export SLACK_BOT_TOKEN

# 1. The token works, and which workspace it is.
curl -s https://slack.com/api/auth.test -H "Authorization: Bearer $SLACK_BOT_TOKEN"

# 2. Find your own member id (U...): in Slack, open your profile, ⋯, Copy member ID.
ME=U0123456789

# 3. Open the DM with yourself as the stakeholder, and keep its channel id (D...).
curl -s https://slack.com/api/conversations.open -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H 'Content-Type: application/json; charset=utf-8' -d "{\"users\":\"$ME\"}"
DM=D0123456789

# 4. Post a question; keep the "ts" it answers with.
curl -s https://slack.com/api/chat.postMessage -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d "{\"channel\":\"$DM\",\"text\":\"Test from 10db. Reply in this thread with A or B.\"}"
TS=1731300000.000100

# 5. In Slack, open the DM from 10db and reply in its thread. Then read the reply back:
curl -s "https://slack.com/api/conversations.replies?channel=$DM&ts=$TS" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"

# 6. Now type a message at the top of the DM (not in the thread), and read the DM's history:
curl -s "https://slack.com/api/conversations.history?channel=$DM&oldest=$TS" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"

# 7. The member list 10db's picker will show (first page):
curl -s "https://slack.com/api/users.list?limit=20" -H "Authorization: Bearer $SLACK_BOT_TOKEN"

# 8. Open a group DM with you and a colleague (their member id from their profile, ⋯, Copy member ID).
#    Keep its channel id, whatever letter it starts with (C… in the check so far).
PEER=U0987654321
curl -s https://slack.com/api/conversations.open -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H 'Content-Type: application/json; charset=utf-8' -d "{\"users\":\"$ME,$PEER\"}"
GDM=G0123456789

# 9. Post a question there; keep its "ts".
curl -s https://slack.com/api/chat.postMessage -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d "{\"channel\":\"$GDM\",\"text\":\"Group test from 10db. Both of you, reply in this thread.\"}"
GTS=1731300000.000200

# 10. You and your colleague each reply in that thread. Then read the thread back:
curl -s "https://slack.com/api/conversations.replies?channel=$GDM&ts=$GTS" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"

# 11. Add a ✅ reaction to the bot's message in the group DM, then read it back:
curl -s "https://slack.com/api/reactions.get?channel=$GDM&timestamp=$GTS" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
#     and read the thread again, to see whether the replies carry the reaction too:
curl -s "https://slack.com/api/conversations.replies?channel=$GDM&ts=$GTS" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"

unset SLACK_BOT_TOKEN
```

Each call answers JSON with `"ok": true`. Step 5 lists the question and your thread reply, each with `user`, `ts`
and `thread_ts`; step 6 lists your top-level message; step 7 lists members with their names and titles. Step 8
answers a channel id (it started `C` when this was first run; nothing depends on the letter); step 10 lists the question and both replies, each with its own `user`;
step 11's `reactions.get` lists `white_check_mark` with your user id. Write down whether step 11's
`conversations.replies` shows a `reactions` array on the bot's message: if it does, 10db reads the ✅ from the
replies it already fetches, and if not, it asks `reactions.get` for it. If step 3 or 8 says `channel_not_found`
or `missing_scope`, or a DM won't let you type, write down the exact error: it decides how 10db sets the app
up. Paste the answers, with the token and ids removed, at the end of
`docs/architecture/research/slack-stakeholder-questions.md` before the build starts.

## 4. In 10db (once built)

1. **Settings › Integrations**: on the Slack card, paste the `xoxb-` token and press **Connect**. 10db checks it
   with Slack, and the card asks you to finish setup: under **Which one is you?**, pick yourself and press
   **That's Me**, so every message carries your name. The card then reads "<workspace> · posts as @10db ·
   you're @you".
2. **Settings › People › Add Person**: find your stakeholder among the workspace's members. Under "Before 10db
   messages them", keep **Show me each message first** for now: you see every message before it goes. "Up to
   10 new questions a day" can be set to **No limit**; it counts only a new question that starts a thread,
   never the replies or the conversation inside one.
3. Tell 10db which questions are theirs: on a question card, **Ask Someone** with "Always send product
   questions on this goal to them", or **Project Settings › Who Answers**, where you can also add a topic
   ("billing, pricing, invoices") for 10db's judge to match questions against.
4. At the foot of People, under "When someone hasn't answered": a reminder in the thread after 4 hours, and the
   question back in your Inbox after 8. Both are measured in real time, so one that comes due while your Mac
   sleeps fires when it wakes.

The first time 10db messages someone, it always shows you the message first.

**Tell your stakeholder once.** The DM arrives from an app called 10db under Apps in their sidebar, not from
you. A line from you first ("I've set up a bot that'll DM you my product questions; just reply in the thread, and
@mention anyone who should weigh in") saves them wondering whether to trust it. When a discussion settles, 10db
posts "Sounds like B… ✅ to approve or reply to change"; a ✅ or a "yes" from them records it.

## Later: instant replies (optional now)

A later 10db picks up replies within seconds over Socket Mode instead of within a minute or two. It needs one
more token, which you can make now to save a second visit: **Basic Information › App-Level Tokens › Generate
Token and Scopes**, name it `10db-socket`, add the scope `connections:write`, and **Generate**. Keep the
`xapp-…` token in your password manager until 10db asks for it.

## A stakeholder outside your workspace

Not in the first 10db, which reaches only your own workspace's members. For later: Slack lets a bot DM someone
from another organisation only when it shares a Slack Connect channel with them, and whether the DM then works
also depends on the other organisation's settings, which Slack doesn't document. That follow-up starts with a
check like section 3's against such a person.

## Disconnecting

**Disconnect**, in the Slack card's menu in **Settings › Integrations**, stops 10db from sending and reading at once. To revoke it for
good, open the app at <https://api.slack.com/apps> and press **Uninstall App** under Install App (or delete the
app): the token stops working everywhere.

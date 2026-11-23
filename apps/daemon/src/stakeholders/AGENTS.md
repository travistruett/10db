# stakeholders

- A send's workspace is its project's: the effective binding (`projectSlack`) decides where a draft is made, and the
  stored one (`boundTeam`) decides where a reserved send may still post. Every post, follow-up, reminder, move and
  closing line uses that workspace's client and the recipient's contact in it.
- Clients are made by team (`createSlackClients`); a client reads its own Keychain item at each call and is null for
  a team that is not in `slack.workspaces`.
- One reply watch runs per signed-in workspace (`createReplyWatches`), each on its own timer and state
  (`SlackConnections`), so a refused or slow workspace never delays another. A watch changes only its own team's
  state; a tick that ends after a Disconnect finds its team gone and sets nothing.
- The bot on record (`botUserId`, `botName`, `botSince` on the workspace entry) is written only by `recordBot`. A
  saved token that names a different bot is a recovery (`recoverFromBotChange`: DM channels and cursors cleared,
  sending and sent sends failed `bot_changed`); a watch's check never recovers. Every place that hands a failed
  send's card back to the builder uses `failSendsToBuilder`.

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
- A draft is made from the effective binding (`projectSlack`): the recipients' contacts in that workspace, or no draft
  and Copy for when the project is Off or anyone has no contact there. A reserved send checks the stored binding
  (`boundTeam`) before every Slack call: another team means it is taken back (`workspace_changed`), a workspace not
  signed in means it waits.
- A change of binding is one write (`rebindProjectSlack`, no Slack call): sending and sent sends elsewhere are failed,
  drafts elsewhere are dropped and drafted again for the same people. A post that lands after its send was failed
  (`workspace_changed`, `bot_changed`) is never recorded sent or drafted again; its thread is told it was taken back
  with the send's own client.
- A follow-up joins only threads sent at or after the workspace's `botSince`; older ones are never joined.
- A reply is one of four kinds (`reply-kind.ts`): answer, simple question, builder question, chatter. The reply
  watch routes it: `handledThroughTs` is the sorting cursor (a lone recipient's reply is the counted messages after
  it; a group's messages are sorted one by one, at most five a tick, and only when the judge can run), and
  `lastReadTs` still moves only when the card is answered. An automated answer is `autoAnswer`: the cap, the stored
  binding, the writer, a re-check of the send, the card and the binding right before the post, the scan, then the
  `auto_answer` line keyed on the reply's first `ts`, found again with `findLine` after a crash. A returned send
  never auto-answers; any question there replaces `asked`. A `ConflictError` from a route ends that send's turn only.
- The lane is told the whole exchange (the recipient's messages, `auto_answer` lines as "10db (automated)" and
  `builder_reply` lines under the builder's name) once the cursor has moved or a which-way line was posted.

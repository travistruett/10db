# Sessions is a top-level screen, and a chat is attended with every builder tool

- **Date:** 2026-11-14

## Decision

- **Sessions is a global screen** (sessions spec S1), third in the sidebar after Inbox and Factory, with its tabs in
  the title bar across projects. Each tab is a chat with an agent in one project.
- **A chat is attended** (S2, S19; trust line §5). Its session is the explore profile as the attended one: Plan's
  read-only sandbox, so the checkout stays read-only until M6; commands judged by auto mode where
  `capabilities.judge` is `native`, and by the `rules` floor elsewhere, said in the session bar; the web where a
  judge sees each call; Claude Code's own subagents and the builder's plugins' agents, none of Plan's; the builder's
  setup with `settingSources: []`; 10db's own `/mcp` and the project's approved servers. Every classifier denial in
  a chat is soft and offers Allow This. Its writes in Your folder come in M6, with the folder hold.
- **"Needs you" is the Inbox** (S13). A tab needs the builder while the Inbox holds an open card whose
  `detail.conversationId` names its conversation, or while its session stopped on an error. There is no second
  queue.
- **Every builder tool is on a chat's token** (S14), plus `set_title`, held to the chat's project, on 10db's own
  `/mcp` (`mcp/server.ts`'s third branch). The tool decides what asks (`chat/tool-policy.ts`): `remove_task` on a
  task the chat did not file (`chat_tasks`), and `retire_knowledge`, `withdraw_knowledge` and
  `supersede_knowledge` every time, raise a permission card owned by the conversation (Allow once or Deny). A Stop
  or an archive withdraws the card and the call says the builder stopped the turn. Every other tool runs,
  `start_task` included.
- **A fresh tab becomes a chat at its first `@` or its first send**, and its project is fixed from then. Until then
  it lives in the window's `localStorage`.
- **Until chats run on Codex (M5b)**, a project on a ChatGPT plan reads "Chats on a ChatGPT account come with the
  next update. Plan, the Board and tasks work as before." in Sessions, and `POST /chats` refuses it with 409 and
  those words.
- **An archived chat comes back** through All Tabs' closed rows (`POST /chats/:id/unarchive`) until M8's ⌘K.
  Archive ends the session in whatever state it is (`ExploreEngine.retire`) and removes
  `<dataDir>/conversations/<id>/`.

## Why

The sessions spec (`docs/superpowers/specs/2026-11-11-10db-sessions-design.md`) and the trust line
(`docs/superpowers/specs/2026-11-12-10db-trust-line-design.md`) give the reasons: the builder works with agents the
way they work in Claude Code, across projects, and 10db holds the line at the limits rather than at every call.

Turned down:

- **Mounting `/builder/mcp` in a session.** It is behind the UI's token, which reaches every route; a session holding
  it could do anything the window can. A session token on `/mcp` reaches only the chat's own tools.
- **A column on `tasks` for the chat that filed a task.** `chat_tasks` keeps the tasks table free of one owner's
  bookkeeping, and is what `edit_task`'s Undo, Recent's count and `remove_task`'s question read.
- **A fresh tab stored on the daemon.** A tab with nothing in it is a window's convenience; the daemon learns of a
  chat once there is something to keep, and a failed first send never makes a second chat.

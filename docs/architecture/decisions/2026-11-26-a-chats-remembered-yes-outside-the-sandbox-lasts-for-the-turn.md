# A chat's remembered yes to run a command outside the sandbox lasts for the turn, on an unchanged checkout

- **Date:** 2026-11-26
- **Amends:** `decisions/2026-11-25-a-chat-asks-before-a-command-runs-outside-the-sandbox.md` (what `allow_chat`
  remembers, and for how long)

## Decision

- `allow_chat` ("For this command in this turn") allows that exact command again for the rest of the turn the
  builder said yes in, and no longer. The chat's next turn asks again.
- Within the turn the command asks again, as before, once the chat changes something or runs another command
  outside the sandbox. It also asks again once another chat's turn joins the checkout, and once the
  checkout's HEAD or working tree differs from what it was at the yes.
- The checkout's state is one hash (`daemon/checkout-state.ts`): HEAD's commit, then each path `changedPaths`
  lists (differs from HEAD, or untracked and not ignored) with its lstat fingerprint (inode, size, change
  times). It is read at the yes and at each remembered call. A state that can't be read is never taken as
  unchanged, and a yes given while it can't be read is not remembered.
- Nothing is remembered while anything other than a waiting chat shares the checkout (another chat's turn, a
  takeover, a lane, a pass, 10db's git work). The card then offers only Allow once and Deny.
- The answered card in the thread reads "You allowed … in this turn".

## Why

- The automated security review of #849 rated the remembered yes medium: it was checked only against the
  session's own change count, which never moves for another holder's edits. Chat B's sandboxed agent could
  edit `package.json`'s `test` script, and chat A's remembered `npm test` would then run it outside the sandbox
  with the builder's rights, unasked. The builder's own edits were never the concern; another agent's are.
- Ending the yes with the turn closes the case between turns. Within one turn the same edit can happen while
  both chats hold the checkout, so another chat joining forgets the yes, and nothing is remembered while the
  checkout is shared.
- Turned down: the fingerprint alone. It can't see a file git ignores (`node_modules`, a build folder), so a
  change there between turns would go unseen. Ending at the turn bounds that.
- Turned down: the turn alone. It misses a sharer that edits within the turn, and an edit by anything that
  holds the checkout without being a chat.
- Turned down: a turn id on the wire. The turn's end already moves the session's change count, which every
  remembered call reads, and a contract change buys nothing more here.
- Reading git once per remembered call and once per yes costs a `rev-parse` and a private-index status. A
  command outside the sandbox already waits on a person, so the cost is small beside that.

## Known gap

- A holder that isn't a chat (a lane, a pass, 10db's git work) that takes and gives back the checkout between
  two calls of one turn, and edits only files git ignores, goes unseen: `remembers` reads the holders only at
  each call, and the hash sees no ignored file.
- A remembered command that itself writes a file that isn't ignored (a coverage report, a lockfile) moves the
  state, so its next run asks again. That fails closed.

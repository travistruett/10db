# A pass runs on the project's account, Claude or Codex

- **Date:** 2026-11-11
- **Supersedes:** W19 ("A pass is Claude only") and the non-goal "Codex in a pass" of
  `docs/superpowers/specs/2026-11-09-10db-workbench-design.md`

## Decision

- **No pass is refused for its account.** Start Pass, the open (`openPass`) and a lane's builder message run
  on the project's own account, Claude or Codex, with the fallback and move-back rules every lane follows. The
  preview's `chatgpt_account` refusal, the open's 409 and the runner's refusal of a Codex session that starts
  for a `feedback` or holds a message no turn took are gone. A builder message to an ordinary task on a Codex
  project is no longer refused either.
- **A Codex turn shows it took a message, as a Claude turn does.** Each message, the prompt's included, goes to
  Codex under a client uuid (`clientUserMessageId` on `turn/start` and `turn/steer`, Codex 0.167.0). The thread
  records it as the `clientId` of the `userMessage` item a turn takes the input in. A recorded message is taken
  once a model item (`MODEL_ITEMS`: a message, reasoning, a tool call, a patch, ...) follows it in its turn, or the
  turn completes; the session reports it then as the `consumed` event the runner already reads. A message a
  turn failed or was interrupted on before the model answered is not taken, and is pushed again.
- **Pictures go as local images.** A message's pictures go after its text as `localImage` items naming the
  stored file, which Codex reads and sends the model; a picture with no file as an `image` of its bytes. The
  thread's picture budget is counted as for any account, under the ChatGPT account's limits.
- **Stop and Redo has a receipt.** A Codex session's queue is 10db's own: the messages its session has not handed
  over yet. `interrupt` answers those as `stillQueued`, waits up to the stop grace for Codex to report the
  interrupted turn ended, and steers nothing into the turn it stops; each held message starts the next turn.
  Codex drops a steered message an interrupted turn had not taken, so every other untaken one is pushed again.
- **A restart never sends a taken message twice.** A message keeps every client uuid it was pushed under
  (`task_messages.push_uuids`), written in the same write as its pushed stamp, before Codex can see it. Before a
  lane resumes a Codex thread while a message pushed under a uuid was never seen taken, 10db reads the thread
  back with a short-lived app-server (`thread/turns/list`, every page, full items; no turn runs) and applies the
  same rule to each turn: a message the thread took is delivered, and a `feedback` whose message was taken
  resumes the thread with no message. A thread that can't be read is never guessed at: the lane is refused, which
  for a page of a pass is a failed turn whose Retry Turn sends the message again. A resumed Claude Code session
  is still pushed the message again (at least once, its id in the text).

## Why

The builder runs ampsio on a ChatGPT plan on purpose: it is a billing line, so moving the project to a Claude
account to open a pass is not acceptable. W19 rested on two gaps found in `sessions/codex-session.ts`: Codex took
no pictures, and nothing showed that a turn took the builder's message, so a page would wait on a message for
ever or act on it twice. The pinned Codex closes both. Seen on the real 0.167.0 binary: `localImage` reaches the
model as an `input_image`; `clientUserMessageId` comes back as the `userMessage` item's `clientId` for a message
started with and one steered in, on the live notifications and in `thread/turns/list` after the process
restarted, read without resuming the thread; a steered message an interrupt beat to the model is never recorded
and does not reappear in the next turn.

Counting the record alone as taken was turned down: Codex records a message as its turn begins, before the model
answers, so a turn that failed on the usage limit at its first model call would mark the message delivered and
the session on the fallback account would start without it. Claude Code stamps a message with the turn's first
assistant message; a model item after the record is the same evidence.

Matching the thread's last user input by text and picture count, for a `turn/start` whose reply never came
back, was turned down: the client uuid is written to the row before the call is made and the thread keeps it,
so a lost reply loses nothing, and matching text could take one message for another.

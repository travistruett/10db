# A session's first change asks where the work happens

- **Date:** 2026-11-17
- **Amends:** `decisions/2026-11-15-a-chat-writes-under-the-folder-hold-and-10dbs-writers-keep-it-alone.md` (a chat
  holds the checkout only after it chose Here)

## Decision

A new session reads, runs read-only commands and searches the web, and holds nothing: it takes no folder hold.
Its first change (an edit tool, a git tool that changes files, or a command the sandbox refuses to let write) is
denied, interrupts the turn and moves the chat to `choosing`, with one card in the Inbox and a bar above the
composer: **Here, on `<branch>`** or **On a New Branch**. The choice is one compare-and-set on `chats.work_place`
in the same transaction as its event and the card's withdrawal; the bar and the card race and one wins. Here
records `here` and posts a carry-on message; from then on each turn takes the checkout's hold, as a chat did.
Push, pull request and merge change no files, so in a reading session they record Here and run with no bar.

## Why

A chat that held the checkout from its first message made every session wait on every other, and made the builder
decide before anything was known. Reading is free and most sessions never write; asking at the first change puts
the one question where it matters, as Claude Code asks about nothing until it must. A bar is a question the
builder can leave; a modal would make unattended work stop. Turned down: asking on the first message (most
sessions never change files); an "always here" setting (a follow-up).

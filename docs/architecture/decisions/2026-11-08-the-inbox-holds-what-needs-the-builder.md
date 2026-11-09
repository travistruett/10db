# The Inbox holds what needs the builder, and nothing from the system check sits above a view

- **Date:** 2026-11-08
- **Amends:** `decisions/2026-11-08-10db-runs-pinned-copies-of-codex-and-claude-code.md` (where "Codex 0.168.0 is
  out" is shown)

## Decision

- **Sorted by what the builder can do.** What the system check finds goes to one of three places
  (`apps/desktop/src/views/inbox/system-cards.ts`), and none of them is a banner above the view:
  - **It needs the builder:** a missing required tool, a refused pinned copy, an unreadable login shell, or an
    Artificial Analysis key that was refused. Each is a 10db card at the top of the Inbox's Open view, saying what
    to do; a refused copy has Fetch It Again. These cards count in Open n, the sidebar badge and the menu bar.
  - **10db is working on it:** a pinned copy being downloaded is a dimmed line in the window's header, naming the
    tool and release. It clears by itself.
  - **Good to know:** the release each copy runs, a newer release that is out, and a version warning are told in
    Settings › Updates, under "Claude Code and Codex". A newer release says "Nothing to do: a 10db update moves to
    it once it has passed its live test on <release>."
- **A 10db card is not an inbox item.** It is derived in the window from `GET /system` and is never stored: it has
  no answer, never reaches Resolved, raises no macOS notification and is not counted by Human touch. It leaves
  when a later check no longer finds its cause.
- The reconnecting banner is the one thing left above a view: it says the window lost the daemon, which no card can
  say.

## Why

Every system finding was a full-width alert above every view, so a newer upstream release, which the builder can do
nothing about, took the top of each screen and pushed the Inbox's own "Nothing needs you right now" down. The
builder asked for one place for anything that needs them. Putting the notes with nothing to do in the Inbox too
would break that promise and its badge, so only the findings the builder can act on go there.

Turned down:

- **Storing them as inbox items.** An item has a project, an owner and an answer, and its rows feed Human touch;
  these are app-wide conditions that end by themselves, and a stored copy could outlive its cause.
- **A dismissable banner.** Dismissing a missing tool doesn't fix it, and a dismissed note returns on the next
  window.

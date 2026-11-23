# A task has one name, its title

- **Date:** 2026-11-22

## Decision

A task has one name, `title`: the plain-words what, a few words on one line ("Odd files can't freeze 10db"). The
desktop shows it everywhere and it is the pull request's title; 10db already adds the Conventional Commit prefix, so
the title carries none. The `headline` field is merged into it: migration 0104 sets `title = headline` where a
headline exists, and 0105 drops the column. `title` keeps its 200-character limit, since existing titles are longer
than the headline's old 80 and the drawer sends the title on every save. `why` is unchanged.

## Why

Two names for one task (a git title and a headline the desktop preferred) meant two fields to write, a fallback in
every view, and a Pull Request Title field the builder rarely understood. Agents drafted both, and they drifted.
One name written the plain way reads well on the Board and in a pull request list alike.

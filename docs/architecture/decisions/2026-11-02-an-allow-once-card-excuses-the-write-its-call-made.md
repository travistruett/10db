# An allow-once card excuses the write its own call made

- **Date:** 2026-11-02
- **Amends:** decisions/2026-11-02-an-excused-write-stays-with-its-lane-its-run-and-its-content.md

## Decision

The Allow Edit card the permission broker raises records what its call writes in `detail.expectedWrite`:
the SHA-256 of the content for a Write (`{ sha256 }`), and the `new_string` texts for an Edit or MultiEdit
(`{ contains }`). The watcher excuses an unused allow-once card's write to its path only when the file holds
that: a Write's exact content, or every text the Edit put in. A file that holds something else, a deletion,
or a file that can't be stamped is carded, and the card stays unused for the write it allowed.

A card with no expectation (a NotebookEdit, an Edit that only deletes text, one whose text is over 256 KiB,
a card raised before this) behaves as before: it excuses the next write to its path.

## Why

In a checkout several lanes share, the watcher can't tell which lane wrote a file. It stamped whatever the
file held when it looked, so a lane B write to the path in the same window as lane A's allowed write was
excused by A's card and used it up. 10db does know what the builder approved: the card comes from A's tool
call, which carries the content or the edit. Comparing the file with that call, rather than taking the file
as the write, ties the excuse to the approved call. An Edit is checked by containment, not by the file's
whole content, because the rest of the file is whatever it held and may have changed since the card was
raised. Containment can still be satisfied by a lane that writes the same text, so it narrows the hole for
an Edit, and closes it for a Write. Turned down: hashing the Edit's result at card time (a legitimate change
elsewhere in the file between card and answer would card the allowed write).

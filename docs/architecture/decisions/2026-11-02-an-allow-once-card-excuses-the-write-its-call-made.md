# An allow-once card excuses the write its own call made

- **Date:** 2026-11-02
- **Amends:** decisions/2026-11-02-an-excused-write-stays-with-its-lane-its-run-and-its-content.md

## Decision

Every Allow Edit card the permission broker raises carries `detail.exactWrite: true`. When the broker lets
the call through (the builder's allowing answer, or the first matching call after an `allow_once` answered
while the lane was parked), it reads the file, applies the call as Claude Code does (a Write's content; an
Edit's `old_string` → `new_string`, once or with `replace_all`; a MultiEdit's edits in turn) and records the
SHA-256 of the result for that lane in `detail.allowedWrites[workstreamId]`. Claude Code writes the file
next. As in Claude Code's `applyEditToFile`, an edit whose `new_string` is empty and whose `old_string`
doesn't end in a newline deletes the newline after its text too, where the file has one there.

A file with CRLF line endings is mirrored: Claude Code reads it as LF, applies the edit, and writes it back in
the file's own endings (CRLF when the first 4096 characters hold more CRLF than bare LF), so a multi-line
`new_string` lands with `\r\n`. The broker does the same before hashing. One case where Claude Code's result
differs from the broker's is not mirrored, and fails closed (the builder's allowed write is carded): an
`old_string` with straight quotes that Claude Code matches to curly quotes in the file.

The watcher excuses an unused allow-once card's write for a lane only when the file's content hash is the one
recorded for that lane. Another lane's write to the path, in the same watch window or not, is carded, both
live and at that lane's step end, and the card stays unused for the write it allowed. A card that asks for
the exact write with nothing recorded for the lane (a NotebookEdit, whose result 10db can't compute; a file
the broker couldn't read; an edit that would fail) excuses no settled write. A file still changing when read
is excused once per card without using it, as before, and the settled file is then checked against the hash.

An Edit, MultiEdit or NotebookEdit card folds only with its own lane's identical asks (`foldPerLane` on the
inbox ask). Folded across lanes, both brokers would read the file on the one answer before either lane wrote,
and the second lane's edit, applied by Claude Code on top of the first's, would match neither hash. With a
card each, a lane's hash is computed when its own card is allowed, normally after the other lane's write has
landed. Write cards still fold across lanes, since a Write's content doesn't depend on the file: such a card
keeps one hash per lane, so each lane's own write is excused and neither lane's write is excused for the
other.

A card without `exactWrite` (raised before this) behaves as before: it excuses the next write to its path.

## Why

In a checkout several lanes share, the watcher can't tell which lane wrote a file. It stamped whatever the
file held when it looked, so a lane B write to the path in the same window as lane A's allowed write was
excused by A's card. 10db does know what the builder approved: the card comes from A's tool call. Hashing
the file that call makes ties the excuse to it exactly; checking only that the file contains the Edit's new
text let B's write through whenever B kept A's text, and left deletions and large edits with no check.

The result is computed when the call is allowed, not when the card is raised, so a change elsewhere in the
file while the card waits doesn't card the builder's allowed write. A write that lands between the broker's
read and Claude Code's makes the call's own write differ from the hash, and it is carded: the race fails
closed. Only a hash is kept, never the call's text, so no content (such as a secret in an Edit) is stored in
the card.

Turned down: recording the write from the PostToolUse tool event. It needs Claude Code's tool response shape
and a hook path the broker doesn't own, and the watcher may see the write before the event arrives.

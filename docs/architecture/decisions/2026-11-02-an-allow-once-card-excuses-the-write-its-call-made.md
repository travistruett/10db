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
`new_string` lands with `\r\n`. The broker does the same before hashing.

Claude Code also normalizes an Edit's input before it applies it. Checked against the Claude Code the lanes
run (2.1.310, by editing scratch files through its own Edit tool, since the native binary isn't in
node_modules to read), with these results:

- **Mirrored: trailing whitespace.** Unless the path ends in `.md` or `.mdx` (any case), every line of
  `new_string` loses the whitespace at its end (`trimEnd`, so a no-break space too; a whitespace-only line
  becomes empty; line separators stay) when the file exists, even empty. An Edit that creates its file keeps
  its whitespace. The broker does the same in `editResult`, before the deletion rule. `old_string` isn't
  touched. MultiEdit gets the same rule, settled once for the call by whether the file exists when the call
  starts; the probed Claude Code offers no MultiEdit tool, so that part isn't probed.
- **Not mirrored, fails closed: desanitizing.** When `old_string` isn't in the file but is once certain
  tokens are swapped for the longer ones Claude Code strips from its own input (`<fnr>` →
  `<function_results>`, and the like), Claude Code matches on the swapped text and swaps the same tokens in
  `new_string`. The broker finds no match, so `editResult` is undefined and the card records no hash.
- **Not mirrored, fails closed: quote style.** An `old_string` with straight quotes that Claude Code matches
  to curly quotes in the file, and then the same curly style in `new_string` (double quotes were
  converted in the probe; an apostrophe in `new_string` stayed straight when `old_string` had no single
  quote). The broker finds no match, so `editResult` is undefined and the card records no hash.
- **Mirrored: an empty `old_string` on a whitespace-only file.** Claude Code replaces the file with
  `new_string` (stripped: `'  \n'` became `'x\n'` in the probe); it refuses only when the trimmed file is
  non-empty. `editResult` does the same for any file whose `trim()` is empty (`'\n'`, spaces, tabs, a CRLF
  file of bare line breaks, which is written back in CRLF), and still returns undefined for a file with content.
- **Not probed, fails closed if it differs: a carriage return in `new_string`.** The probe couldn't send one:
  an `old_string` written with a CR didn't match a file holding that CR, so the CR never reached the tool. The
  broker keeps the CR, so on a CRLF file `x\r\ny` hashes as `x\r\r\ny`. Whatever Claude Code writes that differs
  from that (folding `\r\n` to `\n` first would give `x\r\ny`) doesn't match the hash, and the write is carded.

In each of the "fails closed" cases the builder's allowed write is carded as a stray: noise, and never
an excuse for a write that wasn't approved. Mirroring desanitizing and quote style needs Claude Code's token
table and its curly-quote placement rules, which can't be read from here and change with its version, so a
wrong copy would be worse than carding. The carriage return stays unmirrored for the same reason: no probe
has shown what Claude Code does with it.

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

Answering one lane's edit card with allow_project stores a rule that covers another lane's open card for
the same path, so the inbox service then answers each such card (an open permission card of the project,
marked `exactWrite`, whose storable rule is the same tool and pattern) allow_once, with a note saying a
project rule covered it. It stores no rule and no decision of its own. Each lane's broker, handed that
answer, records the hash of the write its own call makes, as for any allowed edit. The released lanes are
allowed together, so a lane's hash can be read before another lane's write lands and then differ from what
its own write makes; that write is carded, never excused, so the race fails closed. Allow once and
allow-for-workstream answers release nothing, and neither does a card for another path.

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

# The Trust preview names where each item comes from, a protocol change

- **Date:** 2026-11-24

## Decision

`SetupPreviewDto` (inside `ProjectTrustDto.preview`, `GET|PUT /projects/:projectId/trust`) changes shape:
`skills` and `plugins` become lists of `{ what, from }` instead of strings, and each `leftOut` item gains `from`
and `expected`. `from` is the `TrustSwitchKey` that brought the item, or null. `expected` marks a left-out item
the builder would expect (a duplicate name, 10db's own skill), which the page folds into one quiet line.
`PROTOCOL_VERSION` goes from 13 to 14.

## Why

Settings › This Project › Trust shows each switch with the items it brings under it, which needs to know which
switch brought each item. Strings can't carry that. Turning them into objects narrows what an older desktop can
read, so a desktop and daemon of different versions must refuse each other at the handshake rather than fail on
the Trust page; that is what the bump does. Keeping the strings and adding parallel fields was turned down: two
lists of the same items drift.

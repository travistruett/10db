# A principle has a kind and a topic key, and a confirmed one supersedes the same key at the same target

- **Date:** 2026-11-03
- **Amends:** decision 17 (agents only propose principles; supersession is by a fixed key)

## Decision

**Kind.** A principle is a statement with a kind: `policy` (must), `heuristic` (prefer) or `belief` (context).
The kind says how strongly it binds a session; it does not change how the record is stored or found.

**Topic key.** Each principle has a `TopicKey`: lowercase words joined by `.` or `-`, at most `TOPIC_KEY_MAX` (80)
characters. A key made from free text (`topicKeyFrom`) keeps whole words up to the limit. A statement with no Latin
letters or digits gets `untitled-` plus six hex digits of a hash of the statement, so two such statements never
share a key and the second never silently supersedes the first. The builder can change a made key before
confirming.

**Supersede by key and target.** Confirming a principle supersedes the current confirmed principle with the same
topic key **and the same target** (scope, project and area). Principles with different targets never supersede
each other: the builder's own `testing.no-sleeps` (`you`) and a project's `testing.no-sleeps` both stay current.
The match is exact, never by similarity.

**Who writes.** Agents only propose: a proposal stores a `proposed` principle that is invisible to search and the
pack until the builder confirms it, at a scope of the builder's choosing, from the card or the Knowledge view.
The builder can also write a confirmed principle directly. Rejecting a proposal withdraws its proposed principle
with the rejection note as the reason, so the status vocabulary stays `proposed`, `confirmed`, `retired`.

**Search.** `principles_fts` indexes the statement, the topic key and the source quote, kept in step by triggers
on `principles` (migration `0036_principles_fts`, made with `drizzle-kit generate --custom` and never
regenerated). The rationale is not indexed.

## Why

Spec decision 17 and §4 ("Supersession uses fixed keys … never similarity"). A key shared across targets would
let a project's rule silently replace one of the builder's own, so the target is part of the key. A hashed key
for text with no Latin words keeps two non-English statements from sharing a key and erasing each other, which a
plain "untitled" would do. Rejecting by withdrawing avoids a fourth stored status, and the tombstone already
records who and why.

# A topic key made from text that mixes Latin words with another script ends in a hash

- **Date:** 2026-11-03
- **Amends:** decisions/2026-11-03-principles-have-a-kind-and-a-topic-key-and-supersede-by-key-and-target.md

## Decision

The earlier file says a key made from free text (`topicKeyFrom`) keeps whole words up to the limit, and that only a
statement with no Latin letters or digits gets a hash. That is now three cases, not two:

- **Latin script only.** The key is the statement's Latin words and digits, lowercased and joined by `-`, whole
  words up to `TOPIC_KEY_MAX` (80) characters. No hash.
- **Latin words mixed with letters or digits of another script.** The key is the Latin words followed by `-` and six
  hex digits of a hash of the trimmed statement (`testing-no-sleeps-1a2b3c`). The tag takes 7 characters, so the words
  stop at 73 characters rather than 80, and the whole key still fits `TOPIC_KEY_MAX`.
- **No Latin letters or digits.** The key is `untitled-` plus the same six hex digits, as before.

Another script means any letter that is not Latin, or any decimal digit that is not `0`-`9`. Punctuation, spaces and
symbols do not count.

The hash is FNV-1a over the trimmed statement's UTF-16 code units, cut to six hex digits: a short stable tag, not a
security hash. As before, the builder can change a made key before confirming.

## Why

Commit fe128bc, on the task "topicKeyFrom never gives two different mostly non-Latin statements the same key". The
key is built only from `a-z` and `0-9`, so every character of another script is dropped. A statement that is mostly
non-Latin with a few Latin words (a product name, a code term) then reduced to those few words, and two different
statements that shared them got the same key. Under supersede-by-key-and-target the second silently replaced the
first, which is the loss the hash for fully non-Latin text was meant to prevent.

The hash is added only when another script is present, so a Latin-only statement keeps its readable key and two
statements that differ only in their non-Latin words get different keys. The words are cut to 73 characters, not the
tag, because the tag is what keeps the keys apart. A different statement can still hash to the same six digits
(about 1 in 16 million for any pair); the builder sees and can change the key, and an exact-match supersede stays
predictable, so a longer hash was not worth a longer key.

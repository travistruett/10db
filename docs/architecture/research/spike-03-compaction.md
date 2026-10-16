# Spike 03: Compaction control

- **Status:** VERIFIED (disabling auto-compaction, and behavior at the real context limit while compaction is
  blocked: UNKNOWN)
- **Date:** 2026-10-15
- **Versions:** claude 2.1.300 (Claude Code) · Agent SDK 0.3.299 · Node v25.2.1
- **Command:** `pnpm --dir spikes/agent-sdk spike:03`

## Question

`PreCompact` can block compaction; auto-compaction can be disabled.

## Result

`Options.settings: { autoCompactEnabled: true }` turns auto-compaction on per session:
`getContextUsage().isAutoCompactEnabled` reported `true` with it, for haiku and sonnet. Disabling was **not**
shown: `false` reported `false`, but so did the default, so that leg of the check passed vacuously, and whether
`false` would override an enabled default is UNKNOWN. M1 only needs to enable it. With it on, `autoCompactThreshold` was 967,000 of a 1,000,000-token window (96.7%). With no override
the session reported **off**. The builder's machine has `autoCompactEnabled: false` in both `~/.claude.json` and
`~/.claude/settings.json`, and `settingSources: ['project']` did not shield the session from it. The
settings file is not the source: it also has `enabledPlugins` and a `Stop` hook, and spike 1 saw neither (no user
plugins, zero hook frames under `[]`). So the value almost certainly comes from `~/.claude.json`, the global
config, which `settingSources` does not govern. That was inferred, not proven by editing the builder's config.
Either way, a user-level preference reaches 10db's sessions unless 10db sets the value itself.

A `PreCompact` hook returning `{ decision: 'block', reason }` blocked a manual `/compact`: no
`compact_boundary`, a `success` result with the text "Compaction blocked by PreCompact hook: [callback]", and the
session stayed usable (it still recalled "41"). `{ continue: false, stopReason }` did **not** block: the
compaction ran (one boundary), and the session continued. Neither reason string appeared in the messages. An
allowed `/compact` emitted `compact_boundary` with `compact_metadata { trigger: 'manual', pre_tokens: 17802,
post_tokens: 1171 }`. A `SessionStart` hook fired with `source: 'compact'`, and its `additionalContext` reached
the model (it answered MARIGOLD).

Not tested: behavior at the real context limit while compaction is blocked, because filling a window costs too
much quota. That part is UNKNOWN.

## Evidence

```
INFO A: auto-compaction (haiku off / default / on; sonnet default / on): {"off":{"enabled":false,"threshold":null,…},"default":{"enabled":false,"threshold":null,…},"on":{"enabled":true,"threshold":967000,"maxTokens":1000000,…},"sonnetDefault":{"enabled":false,"threshold":null,…},"sonnetOn":{"enabled":true,"threshold":967000,"maxTokens":1000000,…}}
PASS A: auto-compaction controlled per session via Options.settings: off=false default=false on=true
INFO C: compact_boundary: {"type":"system","subtype":"compact_boundary",…,"compact_metadata":{"trigger":"manual","pre_tokens":17802,"post_tokens":1171,"cumulative_dropped_tokens":16631,"duration_ms":2967},…}
INFO C: SessionStart sources seen: ["compact"]
PASS C: allowed /compact emits compact_boundary
PASS C: SessionStart fires with source=compact: ["compact"]
PASS C: re-injected context reaches the model: MARIGOLD
INFO B decision-block: /compact result: {"subtype":"success","text":"Compaction blocked by PreCompact hook: [callback]"}
INFO B decision-block: session still usable: {"answer":"41","error":"none"}
INFO B decision-block: PreCompact blocks manual compaction: {"blocked":true,"fired":1,"boundaries":0}
INFO B continue-false: /compact result: {"subtype":"success","text":""}
INFO B continue-false: PreCompact blocks manual compaction: {"blocked":false,"fired":1,"boundaries":1}
PASS B: at least one PreCompact output shape blocks manual compaction: ["decision-block"]
RESULT 03-compaction: no failures
```

The first run failed A (`off=false default=false`, so "off" could not be told apart from the default) and
reported B per shape as a FAIL for `continue-false`. The probe now also sets compaction on explicitly, adds
sonnet, and checks B as "at least one shape blocks", which is the plan's requirement.

## Consequence for M1

Safe configuration, per decision 2. Compaction stays enabled as the emergency fallback, and **M1b sets
`settings: { autoCompactEnabled: true }` explicitly in the Claude adapter's query options**, because without it
the builder's own preference turns compaction off (as it did here). The threshold is then about 96.7% of
`maxTokens`, above M1a's 70% handoff and 85% firm nudge. The PreCompact hook never blocks: it returns `{}` and
records a deviation. If a block is ever wanted, the shape that works is `{ decision: 'block', reason }`, and
`{ continue: false }` does not block. `SessionStart` with `source: 'compact'` re-injects the context pack
through `hookSpecificOutput.additionalContext`. M1a's runner already
implements the same policy without hooks: on a `compacted` event it records a deviation and re-sends the context
pack. A `SessionStart` callback on `source: 'compact'` is the alternative, which injects at the compaction point
itself.

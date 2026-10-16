# Code style

- **Comments say what and why, timelessly.** No decision numbers, session numbers, dates or
  "new"/"old". A comment that only restates the code is deleted.
- **Constants are `as const` objects** with the type derived from them:
  `export const WorkstreamState = { Queued: 'QUEUED', ... } as const;`
  `export type WorkstreamState = (typeof WorkstreamState)[keyof typeof WorkstreamState];`
  No TypeScript `enum`s (`erasableSyntaxOnly` rejects them).
- **No constructor parameter properties** (`constructor(readonly id: string)`);
  `erasableSyntaxOnly` rejects them too. Declare the field, then assign it in the constructor.
- **No versions in names.** Not `parseV2`, not `schema-new.ts`.
- **No cross-module private imports.** Import another package or module through its entry point.
- **No grab-bags.** No `utils.ts`, `helpers.ts`, `misc.ts` or `common.ts`; name a module after
  what it does.
- **zod at every boundary**: HTTP bodies, MCP inputs, env vars, files read from disk, SDK
  messages, child-process output. Inside a boundary, trust the types.
- **Branded IDs.** A `TaskId` is not a `string`; construct IDs only through the ID module.
- **Typed errors.** Throw subclasses of `Error` with a `name`; never throw strings. A boundary
  converts unknown errors into typed ones.
- **No `any`, no non-null `!`, no `as` casts except at a validated boundary**, with a comment.
- **Small files with one job.** Files that change together live together.
- **Exhaustive switches** over unions; the linter checks.

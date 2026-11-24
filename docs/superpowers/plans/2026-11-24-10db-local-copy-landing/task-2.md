# Task 2: promotion in git

**Size inside the plan:** Core (writes the builder's folder). **Read:** the index's brief and Global Constraints;
spec §5 "Landing" (`Git.promoteFastForward`, the residual window), §8 "Recovery" (the folder classifier).

## Files

- `apps/daemon/src/git/git.ts`: `promoteFastForward`, `classifyFolder`, `finishPromotion` on the `Git` interface
  and in its implementation, beside `mergeIntoBranch` (`:3361`). Reuse `pinned`, `isSymbolic`, `revParse`,
  `currentBranch`, `isAncestor`, `filters`, `changes`, `untrackedInTheWay` and `refusal`; don't call
  `mergeIntoBranch`.
- `apps/daemon/src/git/promotion.test.ts` (new), a real git repository in a temp directory.
- `apps/daemon/src/git/AGENTS.md`: a note on the three functions and their one-lock rule.

## Interfaces it implements (quoted from the index)

```ts
export type Promotion =
  | { readonly kind: 'promoted' }
  | { readonly kind: 'base_moved'; readonly now: string | null }
  | { readonly kind: 'off_base'; readonly head: string | null }
  | { readonly kind: 'in_the_way'; readonly changed: string[]; readonly kept: string[] }
  | { readonly kind: 'index_locked' }
  | { readonly kind: 'filters'; readonly paths: string[] }
  | { readonly kind: 'unclear'; readonly reason: string };
promoteFastForward(input: PromotionInput): Promise<Promotion>;
classifyFolder(input: PromotionInput): Promise<FolderRead>;
finishPromotion(input: PromotionInput): Promise<'promoted' | 'raced'>;
```

## Behavior

- `promoteFastForward`: one `withRepoLock(realpathSync(repo))`, then spec §5's eight steps in order. The written
  paths W are `diff-tree -r --name-only --no-renames -z T C`. Step 5 refreshes the index before `changes` and
  `untrackedInTheWay`. Step 6 maps a `GitError` whose message names `index.lock` to `index_locked`, any other to
  `unclear`. Step 8's rollback runs only when the ref is still T, HEAD still the branch, and `write-tree` equals
  `C^{tree}`; a failed rollback is `unclear`, never swallowed.
- `classifyFolder`: under the same lock, reads HEAD, R, and each W path's index entry (`ls-files -s`) and file
  hash (`hash-object`, missing counts as absent) against T, C and R. Rows A to G exactly as spec §8's table, checked
  in that order. Read-only.
- `finishPromotion`: under the lock, `update-ref --no-deref <ref> C T`; a failure is `raced`. No file is written.

## State-table rows

`promoting` → each `Promotion` kind; `unclear` / recovery → classifier rows A to G.

## Tests (core: git)

1. `promoteFastForward` in a real repository (`maintenance.auto=false`, `gc.auto=0`, `receive.autogc=false`;
   isolated git env):
   - an edit in a written path answers `in_the_way` and leaves the ref, index and files as they were;
   - a file touched (mtime only) in a written path doesn't block: `promoted`;
   - a held `refs/heads/<base>.lock` (created by the test before the call) makes the swap fail with the ref still
     T: the files and index go back to T and the answer is `base_moved`. The daemon runs git with no hooks
     (`git/daemon-config.ts`), so a commit can't be injected between the steps; the hand-commit case (the ref
     moved under C's files) is row G of test 2.
2. `classifyFolder` as one table test: each of rows A to G built as a real folder state, asserting the row.

Value cards: `protects=the builder's folder; fails_when=promotion writes over edits or rolls back under a commit;
why_new=git core`, and one for the classifier (`why_new=recovery core`).

## Done when

Both tests proven red first, then green; typecheck, lint, `make precheck`.

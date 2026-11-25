# Task 3: `programKey`

**Size: Core** (a pure parser the judge's state depends on). Read the index's Brief and Global Constraints first.
Needs nothing; can run beside task 2.

## Files

- `apps/daemon/src/trust/program-key.ts` (new): `programKey(toolName, input, checkout, cwd)`.
  - Only `Bash` (Codex's shell tool too, by the names `skip-recorder.ts` treats as shell) with a string `command`
    and no field beyond the labels `grantCallSummary` allows. Anything else is null.
  - Walk the line as `call-runs.ts` does: past a leading `cd <one bare word> &&`, `env`, and assignments. Share
    that walk; don't write a second one. If it has to move, put it in a module named for what it does.
  - `make [-C dir] <target>` → `make <target>`, or `make -C <dir> <target>` with the folder relative to the
    checkout. No target named → `make`.
  - An interpreter from `call-runs.ts`' `INTERPRETERS` and a script inside the checkout → `<interpreter> <path>`;
    a script run by path → `<path>`; paths relative to the checkout (`within`).
  - `pnpm <script>`, `pnpm exec <bin>`, `npm run <script>`, `yarn <script>`, `bun run <script>` → the runner and
    that word.
  - Otherwise the program word and its first word that doesn't start with `-`.
  - **No key:** a `;`, `&&`, `||`, `&`, a substitution (`$(`, a backtick), a here-document, or a pipe whose later
    segments aren't all allowed by the fast path's read list (`read-allowlist.ts`; reuse its segment check).
    A redirect to a path outside the checkout or the temp folder is no key.
- `apps/daemon/src/trust/index.ts`: export it.

## Interfaces

Implements `programKey` as the index quotes it.

## Spec sections

"The program key".

## Tests

One pure table in `apps/daemon/src/trust/program-key.test.ts`: each key form above; `cd sub && make t`; `env A=1
make t ARGS="x y"`; `make t 2>&1 | tail -20` keeps `make t`; `make t && curl …`, `make t | sh`, `$(…)` and a
here-document give null; a script outside the checkout gives the program word only. Value card:
`protects=which precedent a call is shown; fails_when=a compound or substituted line gets a key, or two targets
share one; why_new=the judge (a pure parser); no_claim=that a keyed call is allowed`.

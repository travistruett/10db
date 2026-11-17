# packages/agent-skill

The `10db-task` agent skill 10db ships: `skill/SKILL.md` and `skill/README.md` are what Claude Code and Codex
follow, and `src/` is its command line (`main.ts` is the bundle's entry), which talks to the running app's local
API.

- Every command takes injected deps (`CommandDeps` in `src/commands.ts`): the API, output, git, files. Tests give
  it a fake API (the network is the boundary); the real API is exercised in the daemon's tests.
- Validate a draft with `TaskInput` and `TaskPatch` from `@10db/contracts`, never with hand-written field checks;
  only the live checks (areas, `dependsOn`, kinds) and the skill's own rule are local. That rule: `create` refuses a
  draft with no `why`, which the form and the API leave optional, because an agent filing for the builder always says
  why the task matters.
- Keep each command's output lines stable: the skill's instructions and builders' habits read them.
- `src/build.ts` bundles `main.ts` with esbuild into `tendb.mjs` beside the two skill files and a `VERSION`
  (a digest of all three). The daemon's build script calls it; the daemon's runtime never imports this package.
- The bundle runs on the builder's own `node` (22+), so its esbuild target is `node22`, not the daemon's.
- The CLI never prints the app's `ui-token`.

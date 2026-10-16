# Agent SDK spikes

Throwaway probes that test the Agent SDK assumptions in the 10db spec (§14) against the installed `claude` and
the builder's own subscription. They are not part of the pnpm workspace, and nothing imports them.

- Node: the project targets Node 26 (M0 pins it). Any Node ≥ 24 runs these probes.
- Install from the repo root: `pnpm --dir spikes/agent-sdk install --ignore-workspace`
- Run one: `pnpm --dir spikes/agent-sdk spike:01` (start with `preflight`)
- Every probe builds its child env from an allowlist. It fails unless the session is billed to the subscription:
  `apiKeySource` is `none`, `apiProvider` is `firstParty`, and `subscriptionType` is set.
- Every probe is bounded: a 180 s abort, a 120 s turn timeout and `maxBudgetUsd: 0.5`.
- `pnpm --dir spikes/agent-sdk typecheck` checks the probes against the SDK types without calling a model.
- Evidence goes to `out/` (gitignored). Results are written up in `docs/architecture/research/spike-*.md`.

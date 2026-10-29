# The sandbox is the boundary, the broker is a filter, and CI decides when a repo has one

- **Date:** 2026-10-29

## Decision

Three layers that kept being treated as security each get one job.

1. **The kernel sandbox is the security boundary.** The lane sandbox and the gate sandbox stay as strict as
   they are, and a change to either keeps its adversarial review. The gate keeps running under `srt`: a gate
   runs tests, and tests are agent-written code. **Built** (`docs/architecture/03-trust-boundaries.md` §3).
2. **The broker's Bash scan is a filter, not a boundary.** It decides when a sandboxed command is plainly
   safe and needs no Inbox card. Anything it misses still runs inside the lane sandbox, so the bar for a
   change to it is "a plain everyday command shouldn't card", not "close every bypass". A command that spells
   a hazard in plain view keeps its card (`pnpm add x` still cards), as R10 requires. A review finding that
   is one more shell-parsing way past the scan gets one round of fixes for its class, and the rest are listed
   as known gaps in the scan's decision (`decisions/2026-10-28-broker-unread-arguments.md`) instead of
   chased. **Built:** the scan already works this way, and its decision says so. **Designed:** the longer-term
   direction is to trust the sandbox and card only what it can't stop, such as a new network host or a
   dependency change. This covers the broker's Bash scan only. Its decision on file-tool reads outside the
   checkout is part of the file tools' boundary (R4) and is unchanged.
3. **When a repo has CI, CI's required checks decide whether work ships.** 10db's sandboxed local gate
   becomes a fast pre-check for such a repo. A repo without CI keeps the local gate, or the builder's check
   when it has no gate command (`decisions/2026-10-28-optional-gate.md`), as what decides. **Designed:**
   today a failed ship gate fails the batch before the push (`apps/daemon/src/delivery/ship.ts`), CI or no
   CI. How a failed pre-check is shown, and when the pull request opens anyway, belongs to the design that
   builds it.

## Why

On 2026-10-28, while 10db ran on its own repository, the friction came from treating all three layers as
security. The security model was sound; the layers on top of it were strict in the wrong places.

- **The broker work had no end.** It parses shell, and that is endless: #95 went through six rounds of
  automated findings on bash arithmetic tricks, and each fix added cards that nearly flooded the Inbox.
  Every variant it missed would still have run inside the lane sandbox. The threat model already lists the
  broker's cards as policy (§3: "A policy layer may refuse more than the boundaries, never less"); this
  decision says what follows for how its changes are judged.
- **The local gate blocked work that was fine.** The sandboxed gate failed on macOS toolchain quirks (mise,
  `xcrun`, rustup) while the code was correct, and CI plus a review got the work shipped. The areas and
  hazards editor (#106) shipped by hand after 10db's own gate failed on its environment. With the local gate
  in charge, every toolchain quirk stops shipping.
- **The sandbox reviews earned their cost.** They found real escapes, such as a lane planting a mise
  config that the unsandboxed claude process would then run. The sandbox was incompatible with some
  toolchains, never too strict, so it is the layer that stays strict.

Turned down:

- **Hardening the scan into a complete shell parser.** It can't be complete against bash and zsh (threat
  model §7), and the sandbox already bounds what a missed command can do.
- **Dropping the gate sandbox to stop the toolchain failures.** The gate runs agent-written test code; the
  fix for a quirk is a sandbox that works with the toolchain, as `decisions/2026-10-28-sandbox-toolchain-reads.md`
  did.

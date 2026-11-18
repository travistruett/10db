# Inbox signal: the Inbox holds only what needs the builder

**Status:** designed on 2026-11-17, not built. Revised after review rounds 1 and 2.

**Builds on Inbox M3,** which is in flight. Its plan is `docs/superpowers/plans/2026-11-17-10db-inbox-m3.md`. It
lands on main as part of the `feat/sessions-and-inbox` PR, after `feat/shell-codex-frame`.

Its orchestrator confirmed on 2026-11-17 where this design plugs in:

- **What counts in Open n** is decided in one place: `openRowsPage` in `packages/db/src/store/inbox-open-rows.ts`.
  Its `total` feeds the Open count, the rail badge and the menu bar. The desktop adds the derived 10db system cards
  to it (`views/inbox/inbox-count.ts`).
- **Which cards share a row** is decided by `inboxRowKey` in `packages/contracts/src/inbox-rows.ts`.
- **Notifications** still read `GET /inbox`.
- **What M3 does not touch:** `InboxService.flag`, `load/`, the watcher's cards, notifications and `inbox_items`.
- **The switch** stays Open / Waiting / Resolved, so Activity is this design's addition.

## Brief

**What changes for you.**

- The Inbox counts, badges and notifies only **asks**: cards where you choose something 10db then does, or a fix
  you make elsewhere that 10db watches for and closes the card on.
- What tells you something and asks nothing goes to **Activity**, a list beside Open, Waiting and Resolved. It is
  kept, searchable and never counted. It raises no notification.
- A live condition 10db handles by itself (the Mac overloaded, a model list loading, an update held) is a
  **status line** in the header while it lasts, the way a pinned copy downloading already is.
- Every flag stops being "high". High now means work is stopped or will be lost until you act.
- A card raised for a condition closes itself when the condition is gone. That includes a failed update after a
  later one succeeds.
- **A card raised for a condition has no Dismiss.** It is updated in place while the condition lasts and leaves
  when the condition is gone, so it can't come back after a dismiss.
- **`.git` writes.**
  - Git hooks stop running a lefthook binary from inside a checkout's `node_modules`. That also closes a path out of
    the sandbox that exists today.
  - Lefthook's checksum file and git's own branch and worktree entries in `.git/config` stop raising cards.
  - Any other write there still raises a card, now with a **Trust this version** answer, which you give once per
    lefthook version.
- **Later and optional (S5):** the judge answers a lane's question or permission from your existing decisions and
  principles, citing which, and ranks how urgent the rest are. It may answer or reorder. It never hides an ask.

**What it buys.** Of the 73 flags raised from 2026-11-10 to 2026-11-17, 71 offered only Dismiss. Under S1 and S2,
about 6 of those 73 would have counted. After S4, none would. Since 2026-10-28, you acted on 75 of the 77 flags
that offered a real choice, and on none of the 325 that offered only Dismiss.

**What could go wrong, and how we'd know.**

- *A real ask lands in Activity and a lane waits on it.* An ask is told apart by its type in code, not by a guess.
  Every card builder declares its tier. A repo test fails on a builder the sort table doesn't name. No runtime
  check can drop a card.
- *A card never closes.* Every flag declares how it closes, and each new closer is tested on the rung of what it
  watches.
- *You miss the Mac being overloaded.* The status line shows it, with the busiest processes, for as long as it
  lasts.
- *A trusted hook hides a bad one.* No hook is excused by its shape. Trust is keyed on the file's exact sha256 and
  is checked again when you answer, so any other content raises a card.

**Calls you might disagree with.**

1. **Overload becomes a status line only, with no card at any duration.** Agreed by the builder on 2026-11-17: "It's
   pointless as an ephemeral inbox notification." Low disk stays an ask, because only you can free space and lanes
   stay held until you do.
2. **Activity lives in the Inbox panel,** as a fourth switch item after Resolved.
3. **Activity reads the event log** (`events`), so it needs no migration. An Activity entry can't be edited or
   cleared; it's history.
4. **Stray writes stay asks** and gain Trust this version. They are the sandbox's integrity check, so a write
   there never becomes a notice.
5. **A condition card can't be dismissed.** Low disk, a batch on the wrong branch and a broken MCP config stay in
   Open until they're fixed, because a lane is held until then.
6. **Opt-out notices with an undo** ("Docker is on", "moved to the fallback account") stay asks at low urgency,
   because their undo is a real answer.
7. **The judge milestone (S5) defaults to later.** The Inbox is quiet without it.

**Needed from you:** cut the roadmap's milestones
(`docs/superpowers/plans/2026-11-17-10db-inbox-signal-roadmap.md`). Nothing else.

---

## 1. Why

The builder reported on 2026-11-17 that the Inbox "feels like a lot". The live database on that day held 770
cards since 2026-10-28:

| Kind | Cards | Answered with a real choice | Dismissed | Withdrawn by 10db |
| --- | --- | --- | --- | --- |
| flag, offering a real choice | 77 | 75 | 0 | 2 |
| flag, offering only Dismiss | 325 | 0 | 205 | 107 |
| permission | 236 | 236 | 0 | 0 |
| question | 58 | 58 | 0 | 0 |
| proposal, review, check | 74 | 63 | 0 | 11 |

Two of 10db's rules already say what the Inbox is for:

- `decisions/2026-10-31-notices-not-cards.md`: "The Inbox holds what needs the builder's answer."
- `decisions/2026-11-08-the-inbox-holds-what-needs-the-builder.md` sorts system findings into needs-you,
  10db-is-working-on-it and good-to-know.

Both were applied one card type at a time. About 45 call sites raise cards, and more than 20 card types still offer
only Dismiss, because nothing stops new code from doing it.

Four mechanisms keep the noise coming:

1. **Every flag is high.** `flagCard` hardcodes `urgency: high` (`apps/daemon/src/inbox/service.ts`), so every flag
   sorts above every question.
2. **A dismissed card comes back.** A fold key looks only at open cards, so the next raise after a dismiss inserts a
   new card and notifies again. For example, the low-disk card is raised again when its GB figure changes.
3. **Some causes never close their cards.**
   - the self-update failure;
   - "Batch … waits: wrong branch";
   - the repo MCP config cards;
   - "The gate failed as … closed";
   - "Write inside another workstream's claim";
   - the git refusals with no Trust candidate.
4. **A flapping condition makes a card each time.** The overload card was raised 57 times in seven days and withdrew
   itself 56 times. Each raise was a new card and a new notification.

The worst source of real false positives is shared `.git`. Every worktree shares one `.git`, so `pnpm install`
anywhere runs `lefthook install`, which rewrites `.git/hooks/*` and `.git/info/lefthook.checksum`. Separately,
`git worktree add -b` and `git push -u` write `.git/config`. The builder dismissed these with the same note about 20
times between 2026-10-28 and 2026-11-17. Sensitive paths never close by claim (`watcher/watcher.ts`, the
`isSensitivePath` checks), so these cards stay open until dismissed.

Prior art agrees. Google's SRE book says "every page should be actionable" and "if a page merely merits a robotic
response, it shouldn't be a page". Prometheus delays an alert with `for` and holds it with `keep_firing_for`, so a
flapping condition makes one alert. Elastic warns that a permanent exception widens what counts as benign, and that
tuning the rule is the only fix that improves the signal itself.

## 2. Goals, non-goals, anti-goals

**Goals**

- The Open count, the rail badge, the menu bar row and macOS notifications cover asks only.
- Every card type has one tier, set in code, and a test fails when a new card builder has none.
- Every flag says how it closes. A condition card closes itself when its cause is gone and offers no Dismiss.
- The `.git` false positives are fixed at their source.
- Optionally (S5), the judge answers from existing knowledge and ranks asks.

**Non-goals**

- Redesigning the Inbox's look, paging or grouping. That is Inbox M3's job; this design uses its row key and
  counts.
- Notification channels beyond today's (Slack routing, sounds, Focus levels).
- Reducing the machine's actual load. That is a separate task (§10).

**Anti-goals.** Each of these is a failure even if the counts drop:

- An ask that a lane waits on never reaches the builder.
- A card that should be raised is dropped by an error.
- A security-relevant write (`.git/hooks`, agent config) becomes muteable by path.
- A model decides whether something is shown to the builder.
- The rule depends on an OpenRouter account.

## 3. Approaches considered

- **A. Fix card by card.** About 15 small tasks. This has been the practice since 2026-10-31, and the Dismiss-only
  cards came back because nothing prevents new ones. Rejected.
- **B. A tier for every card, enforced, with homes for notices and status (chosen by the builder,
  2026-11-17).** It is the only approach that stops new noise.
- **C. Display-only split.** The desktop shows "Needs you" and "FYI" by whether a card has options. Stale cards
  stay stale, nothing stops new noise, and it puts the rule in the browser, which
  `decisions/2026-11-16-the-open-inbox-is-paged-by-row-and-the-daemon-groups-the-rows.md` moved to the daemon.

**The judge as the sorter was rejected (builder, 2026-11-17).** It adds a way to lose a real ask, fixes none of
the four mechanisms, and works only with an OpenRouter account. Its place is S5.

## 4. The three tiers

| Tier | What it is | Where it shows | Counted, badged, notified | Stored as |
| --- | --- | --- | --- | --- |
| **Ask** | The builder chooses something 10db then does, or makes a fix elsewhere that 10db watches for | Inbox › Open | yes | `inbox_items` |
| **Notice** | 10db did or saw something, and nothing is asked | A batch's notice when it belongs to one batch; otherwise Inbox › Activity | no | `batches.notices`, or the `events` log |
| **Status** | A live condition 10db handles by itself | A header status line while it lasts | no | derived in the daemon, never stored |

### 4.1 What an ask must have

A flag is an ask only if it has one of two things:

- **An acting answer.** At least one option whose handler changes something: Retry, Delete Branch, Trust, Move
  back, Switch back, Try Again, Abandon. "Later", "Got it", "Clear the notice" and dismiss are not acting answers.
- **A fix elsewhere plus a closer.** An option that opens where the fix is made (Settings, the config file, the
  folder), plus a `closesWhen` condition that sees the fix and resolves the card.

**How this is enforced.**

- **At compile time.** The tier and `closesWhen` are required on `FlagInput` and on the delivery `Card` type
  (`delivery/cards.ts`), so `raise`/`raiseIn` and every `flag(` call get them from their builder and never from a
  default.
- **In review, through the S3 repo test.** It fails when a card builder or a `flag(` call site is missing from the
  sort table, or when the table names a Dismiss-only ask with no closer.
- **Never at runtime.** `flagCard` never throws for a contract breach, because callers that catch and log (for
  example `load/disk.ts`, `load/monitor.ts`) would drop the card.

### 4.2 Notices

- **Batch-scoped notices** use the existing `batches.notices` list, keyed and unchanged.
- **Run-scoped notices are not used for new notices.** `workstreams.notice` holds one notice per run, and every
  daemon start clears it (`packages/db/src/store/workstreams.ts`), so a second notice would overwrite the claim
  wait.
- **Every other notice** is posted as a `notice.posted` event:
  - payload `{ projectId | null, taskId | null, key, tone: info | warning, line, body }`;
  - entity type `project`, or `app` when it has no project.
- A notice with a `taskId` links to the task, and the task's drawer lists its notices.
- **Activity** reads those events newest first, paged by event `seq` with Inbox M3's keyset shape.
  - It reads per project through `events_entity_idx` (`entity_type`, `entity_id`, `type`).
  - If the plan measures a cross-project page as too slow on a 250k-row log, it may add an index. That would be the
    milestone's one migration, agreed with the Sessions orchestrator first.
- Identical notices with one `key` within 10 minutes show as one row with a count, grouped when read.

### 4.3 Status

- **Status is derived in the daemon** and served by a new `GET /status`, with a `StatusDto` in
  `packages/contracts`. A `status.changed` event tells the desktop.
- **What a status line holds:**
  - the admission gate's holds (load, disk, lane cap), with the busiest processes from `load/culprits.ts`, which
    `AdmissionDto` does not carry today;
  - the self-update hold;
  - each account waiting for its model list, which is in-daemon only today (`daemon/start.ts`,
    `scheduler.ts`).
- **The header line** is drawn where the pinned-copy download line is drawn today (`shell/agent-download-status.tsx`).
  - It shows one line, for example "Holding new lanes: the Mac is overloaded (load 23 on 10 cores)".
  - Clicking it opens the details today's card body carries.
- **Hysteresis lives in the daemon,** on the injected clock. A status is shown once its hold has lasted 2 minutes,
  and kept for 2 minutes after the hold lifts. A window reload reads the daemon's current state, so it doesn't
  reset the hysteresis. A daemon restart starts it again, which is acceptable. The guard's own thresholds are
  unchanged.

| Hold state | The hold starts | The hold lifts | 2 min pass | The daemon restarts |
| --- | --- | --- | --- | --- |
| none | pending (not shown) | — | — | none |
| pending | — | none | shown | none (re-derived) |
| shown | — | lingering | — | none (re-derived) |
| lingering | shown | — | none | none |

### 4.4 Urgency

`FlagInput` and `Card` gain a required `urgency`. The ladder is:

| Urgency | Meaning | Examples |
| --- | --- | --- |
| high | Work is stopped, or will be lost, until the builder acts | Workstream failed, Not started, Batch not shipped, Claim deadlock, usage limit or cap reached, low disk, stray write |
| normal | Something should be decided, but nothing is stopped | Delete a branch?, MCP server approval, Docker needed, network host |
| low | An undo offer or an optional choice | Docker is on (Turn it off), moved to the fallback account (Move back), proposals |

The Open list still sorts by urgency, then age. A notification fires for every ask, as today.

### 4.5 How a card closes, and what can be dismissed

`FlagInput` and `Card` gain a required `closesWhen`, which is one of two forms:

- **`{ by: 'answer' }`.** The card closes when the builder answers it.
- **A `CardResolvesWhen` condition.** The existing union in `card-resolution.ts`, extended with three events:
  - `update_installed`: closes a self-update failure.
  - `branch_ready` with `{ batchId }`: closes "Batch … waits: wrong branch" and "checkout is on X".
  - `mcp_config_changed` with `{ projectId, hash }`: closes the repo MCP config cards when the config's hash
    changes.
  
  Each is wired where the success is known, as `resolveStaleCards` already does.
- **Cards that already withdraw themselves keep doing so,** with `closesWhen` naming what they use today:
  - the disk card (`load/disk.ts`, on the hold lifting);
  - "worktree missing", which already offers Abandon;
  - the shape hold;
  - the account and PR cards.

**A condition card has no Dismiss.**

- A card whose `closesWhen` is a condition is raised with `refresh`, so a repeat updates it in place.
- The Inbox offers it no Dismiss, so nothing can be dismissed and come back. It leaves when its closer fires.
- No dismissal is recorded anywhere, so none can get stuck. That rules out a recorded dismissal hiding a later real
  ask after a restart or a missed closer.
- A `by: 'answer'` card keeps Dismiss beside its acting answers.
- **Stray-write cards are `by: 'answer'`,** and their Dismiss closes only that card. The next write to the path
  raises a new one.

**Tiers aren't stored.** A notice is never an `inbox_items` row, and a status is never stored, so every stored flag
is an ask. `openRowsPage` needs no change. The tier is declared on the card builder for S3's test, not kept on the
row.

## 5. Every card type, sorted

This is the inventory of `apps/daemon/src` on 2026-11-17, with the round-1 additions. The S1 plan re-reads it
against main.

**Already asks.** These need only an explicit `urgency` and `closesWhen`:

- permission and network-host asks; lane questions; shared-code asks;
- proposals; builder check; plan approval; Ready pages; Turn failed;
- Workstream failed; Retry delivery; MCP server approval; Docker needed; gate host; hazard removals;
- git refusal with a Trust candidate; Claim deadlock; every account card;
- the pass folder wait; move-to-copy; Not started; Batch not shipped;
- the worktree cards, including "worktree missing" with Abandon;
- "Your checkout stays on"; the PR cards; Delete a branch?; left-out; pass settle and stack;
- Skipped while you were away; low disk (with Open Capacity settings added).

**Changes tier, or gains what an ask needs:**

| Card (source) | Today | Becomes |
| --- | --- | --- |
| The Mac is overloaded (`load/monitor.ts`) | Dismiss-only, flaps | **Status** |
| `<acct>` is waiting for its model list (`accounts/model-list-wait.ts`) | Dismiss-only | **Status** |
| A shaping conversation is holding the update (`self-update.ts`) | Dismiss-only, closes itself | **Status** |
| Updating 10db failed (`self-update.ts`) | Dismiss-only, never closes | **Ask**: Try Again; closes on `update_installed` (§6) |
| Batch … waits: wrong branch; Batch … failed / Not added to batch: checkout is on X (`delivery/cards.ts`, `launch-rule.ts`) | Dismiss-only, never closes | **Ask**: Switch Back (as `checkout-return` does); closes on `branch_ready` |
| Repo MCP config can't run / stops sessions / check it (`project-mcp-reader.ts`) | Dismiss-only, never closes | **Ask**: Open the Config; closes on `mcp_config_changed` |
| `<acct>` cannot run `<model>`, when 10db did not retry (`runner.ts`) | Dismiss-only | **Ask**: Choose Another Model (opens the account's models); closes by answer |
| `<acct>` cannot run `<model>`, when 10db retried on another model (`runner.ts`) | Dismiss-only | **Activity**, with the task |
| Write outside every claim, single and bulk (`watcher/watcher.ts`) | Dismiss-only, sensitive paths never close | **Ask, high**: Trust This Version (§7); non-sensitive paths still close when a claim covers them |
| Write inside another workstream's claim, single and bulk (`watcher/watcher.ts`) | Dismiss-only, never closes | **Ask, high**: Keep It (Trust This Version for each path) or Show the Diff; closes by answer |
| N local branches under `10db/` without a task (`delivery/cards.ts`) | Dismiss-only | **Ask, normal**: Delete Them / Keep; closes when the list is empty, as today |
| `<branch>` is left from a UI Workbench pass that did not open (`delivery/cards.ts`, `pass-recover.ts`) | Dismiss-only, gives git commands | **Ask, high**: Open the Folder; closes when the branch is gone |
| Git refusal with no Trust candidate (`daemon/git-refusal.ts`) | Dismiss-only, never closes | **Ask**: Open the Checkout; closes when the next git call of that kind on that repo passes. The plan finds the seam in `Git`, which already re-checks refused checkouts for the Trust kinds. |
| Couldn't regenerate files / lost migrations (`delivery/cards.ts`) | "Clear the notice" | Stays an **Ask**. The plan checks whether its answer acts. If "Clear" only closes it, it gains Regenerate or becomes a batch notice. |
| The step left changes in its claims; Session ended without the handoff (`runner.ts`) | Dismiss-only | **Activity**, with the task |
| `<task>` was resized (`mcp/tools.ts`) | "Got it" | **Activity**, with the task |
| Batch … abandoned: branch deleted (`delivery/cards.ts`) | Dismiss-only | **Activity** |
| UI Workbench pass … closed when its pull request merged (`pass/merged-open.ts`) | Dismiss-only | **Activity** |
| Pass cancelled for 10db's update / did not open (`daemon/start.ts`, `pass/open-when-busy.ts`) | Dismiss-only | **Activity**. One shared notify callback raises these, so it takes a tier from each caller. |
| Your folder stays on `<branch>` (`pass/fast-forward.ts`) | Dismiss-only | **Activity** (warning) |
| The gate failed as UI Workbench pass … closed (`pass/close.ts`) | Dismiss-only, never closes | **Activity** (warning) |
| N tasks moved off `<branch>` (`retired-landings.ts`) | Dismiss-only | **Activity** |
| 10db removed nothing at `<path>` (`delivery/cards.ts`) | Dismiss-only | **Activity** (warning) |
| UI Workbench pass … abandoned, with no Move option (`pass/abandon.ts`) | Dismiss-only | **Activity**; with a Move option it stays an ask |

**Effect.** Over 2026-11-10 to 2026-11-17, the counted flags would have been 5 stray writes and 1 self-update card.
The self-update card would have closed itself. S4 removes the stray writes.

## 6. Try Again on a failed update

Try Again runs the same install the self-updater runs, for main's newest finished build, through the existing
`retry()` path. The table below says what happens when it races other events.

| State when Try Again lands | Result |
| --- | --- |
| No install running, no hold | The install starts. Success fires `update_installed`, which closes every open self-update failure card. Failure rewords the card (`refresh`). |
| An install already running | The answer is recorded. The running install's outcome decides the card. |
| A shaping hold on | The install waits for the hold, as an automatic one does. The status line shows the hold. |
| Main has a newer build than the card names | The newest is installed. The card closes on success either way. |
| The install restarts the daemon | The new daemon, at start, fires `update_installed` for every open self-update failure card whose commit is at or behind the commit it runs. |
| A rollback (`make rollback-app`) puts an older build back | The started daemon runs an older commit, so the card stays open, which is correct: the update did not take. |

## 7. Stray writes in `.git` (S4)

`.git/hooks`, `.git/info` and `.git/config` stay sensitive paths (`watcher/strays.ts`). The fix narrows what counts
as a stray write there. It does not mute these paths. There are three parts.

1. **Hooks never run a binary from a checkout's `node_modules`.**
   - **What happens today.** `lefthook install` runs from the npm package's postinstall. It writes hooks whose
     fallback is the absolute path of the lefthook binary in whichever worktree ran `pnpm install`. For example, on
     2026-11-17 `.git/hooks/pre-commit` named `…/10db-worktrees/inbox-m3/node_modules/.pnpm/lefthook-darwin-arm64@2.2.2/…/bin/lefthook`.
     `lefthook` is not on the builder's PATH, so that fallback is what runs.
   - **Why it matters.** `node_modules` is not a sensitive path. A lane that can write the named checkout's
     `node_modules` can replace that binary. It would then run outside the sandbox on the builder's next commit in a
     terminal. 10db's own git calls are safe: they set `core.hooksPath=/dev/null` (`git/daemon-config.ts`).
   - **The change.** The plan picks the mechanism; the likely one is to pin lefthook in `mise.toml` and install hooks
     from that binary, not from the package's postinstall. It must meet two requirements:
     - The installed hooks name no path inside any checkout.
     - The installed hooks are byte-identical whichever checkout installed them.
     
     Nothing is excused by its shape. Byte-identical hooks mean one Trust This Version per lefthook version, not
     one per install.
   - **The checksum file.** `.git/info/lefthook.checksum` holds only a hash and a timestamp, and lefthook reads it
     only to decide whether to reinstall. It is excused when it is exactly that path and matches
     `^[0-9a-f]{32} \d+\s*$`. Any other file in `.git/info` stays sensitive.
2. **Trust This Version.**
   - **The stamp.** The watcher stamps a stray write's sha256 into the card's detail when it raises the card. A
     repeat write to the same path is raised with `refresh`, so the card always shows the latest content and stamp.
   - **The check.** When the builder answers Trust This Version, 10db stamps the file again.
     - If it matches the card's stamp, `{ path, sha256, trustedAt }` is stored in an app setting,
       `trusted_writes.<projectId>`, which needs no migration, and the card closes.
     - If it doesn't match, nothing is trusted, and a fresh card shows the new content.
   - **After that,** a write that leaves a trusted path holding exactly a trusted sha256 raises no card.
3. **Git's own config bookkeeping.** The watcher keeps the last `.git/config` it saw, parsed with
   `git config --file <copy> --list`.
   - A change confined to `branch.<name>.*`, `worktree.*` or `extensions.worktreeConfig` raises no card. These are
     what `worktree add`, `push -u`, `branch --set-upstream-to` and `checkout -b` write.
   - Any other key, such as `core.hooksPath`, `remote.*.url` or an `alias.*`, raises a card. The card body names
     the changed keys.

A test of each part runs against a real git repo in a temp dir, rung 4, with maintenance off:

- hooks installed from two different worktrees are byte-identical and name no checkout path;
- a hand-edited hook must raise a card, and so must a trusted hook rewritten while its card is open;
- a real `git worktree add -b` and `push -u`;
- a real `git config core.hooksPath`, which must raise a card.

## 8. The judge (S5, later)

There are two new `JudgeDecision`s. They run through `judge.choose`, as `task_rigor` does, and are logged to
`judge_calls`.

- **`answer_from_knowledge`.** Before a lane's question or permission card is stored, the judge gets the card and
  the project's current decisions and principles. It returns one of two things:
  - "none applies";
  - one of the card's options, plus the decision or principle id that answers it.
  
  At or above the floor, 10db answers the card at once and records `answeredFrom: <id>`. The card goes to Resolved
  as "Answered from `<decision title>`". Below the floor, or on a fallback, the card is stored as today. This is
  spec §7's "answered from D-n", and it absorbs `tsk_01a1a464`.
- **`ask_urgency`.** For a lane's question only, the judge picks `high` (a running lane is blocked on it), `normal`
  or `low`.

Guardrails:

- Both decisions run in shadow first, on the existing Decisions page.
- The judge never moves a card out of Open unanswered, never answers a hard-limit permission, and never answers a
  question addressed to a named person.
- The builder can reopen an "answered from" card. Doing so records the call as `overridden`.

## 9. Provider parity and trust

**Parity.** Tiers, notices, status, closers, urgency and the `.git` fixes are 10db's own records and watcher. No
provider is called, so they behave the same on a Claude plan, on Bedrock or an API key, and on a ChatGPT/Codex plan.

The S5 judge runs on whichever OpenRouter account the builder set for decisions, whatever account a project runs
on. With no OpenRouter account the judge is off, and every ask reaches the builder as today.

| Milestone | Claude plan | Bedrock or API key | Codex plan |
| --- | --- | --- | --- |
| S1 to S4 | 10db's records and watcher | same | same |
| S5 | the judge, through OpenRouter | same | same; Codex lanes' questions are stored the same way |

**Trust.** No new restriction on agents. S4 loosens one: it excuses writes that are provably git's or lefthook's
from this project's own checkouts. The sensitive-path rule stays for the sandbox's integrity. S5 lets 10db answer
for the builder only from the builder's own recorded decisions, never across a hard limit.

## 10. Out of scope, filed as separate tasks

- **Reduce the Mac's load.** Sweep merged worktrees on a schedule. Offer to exclude `~/Projects/10db-worktrees`
  and `~/.10db/worktrees` from Spotlight. Measure fseventsd. On 2026-11-17, fseventsd ran near 98% of a core, and
  mds_stores had used about 145 CPU-hours in 12 days, with 31 worktrees present.
- **Per-type noise report.** The share of each card type dismissed or withdrawn, on the Factory page.

## 11. What is left to the plans

- How the desktop draws the Activity switch item, the status popover and a task drawer's notices. They must follow
  Inbox M3's panel and `DESIGN.md`.
- The exact wording of each new answer and line.
- The mechanism that installs hooks from a builder-owned lefthook (§7.1).
- How a task's drawer finds its notices without reading inside the event's JSON (§4.2). One option is posting with
  entity type `task`.
- Whether a cross-project Activity page needs an index (§4.2).
- The `Git` seam for the no-candidate refusal's closer (§5).

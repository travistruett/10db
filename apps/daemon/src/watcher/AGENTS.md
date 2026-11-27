# apps/daemon/src/watcher

- The watcher flags a write to a sensitive path (`watcher/strays.ts`: agent and tool config, `.env` files, `.git` hooks, info and config) even when git ignores it, and even inside a claim that covers it. In a batch's copy, a sensitive path that holds only what 10db's own base merge or fast-forward brought in is not flagged (an `apps/daemon/.env.example` in a merge was the one file of 321 that carded, because sensitive paths skipped the "git still reports it as changed" test every other merged file passed): a file git reports as unchanged whose HEAD blob is the one the incoming base holds (`refs/remotes/origin/<base>`, which base-update merges from, or the batch's recorded `baseSha`), or a directory that holds files and only such files. "HEAD holds it and the checkout matches" is not enough: a lane's own `mcp__10db__commit` of `.mcp.json` before its watcher batch runs looks the same, and its blob is in no base, so it still cards. An edit or deletion, a new file, an ignored or untracked one (`.env`, `.git/config`), a directory a lane added a file to, and any committed sensitive file in the main checkout (which 10db never merges into) still card. A lane can run before it holds the claim its work needs (a task with no areas, such as one filed from an accepted proposal, launches holding nothing and takes a claim through `request_claim`), so when a claim is granted (`ClaimAcquired` on the bus) the watcher resolves each open "Write outside every claim" card that names the lane granted it (as its workstream or a candidate), in that lane's checkout, whose path a claim the lane now holds covers. A claim granted to any other lane, including one the scheduler grants as it launches the next lane in the same copy, resolves nothing, and sensitive paths stay open. Claude Code's own bookkeeping is not sensitive (`git/claude-code-bookkeeping.ts`): only `.claude/.cc-writes` as a real directory (a link or file there is still flagged), its atomic-write staging directory, which it creates at every session start and never reads as config, so it is dropped while git ignores it and judged against the claims when git reports it. `.claude/scheduled_tasks.lock`, the session's own lock for scheduled tasks, raises no card at all (a symbolic or hard link, or a directory, there is still flagged): the watcher drops it at a batch and at a step's end. Every write dropped because it is on the list is logged as "ignored a Claude Code bookkeeping write" with the entry's `writtenBy`, so the daemon log shows what the list hides. The list applies in every `.claude/` folder of a lane's copy, not only the top-level one (a command run in `.claude/hooks` leaves `.claude/hooks/.claude/.cc-writes`): an entry matches as the whole tail of a path, so `x/.cc-writes` and `.cc-writesx` stay flagged, and a real file beside it (`.claude/hooks/.claude/settings.json`) still cards. The commit tool never stages such a file or a path inside such a directory (`stage` in `git/git.ts` puts them back as the tip has them, and `onBookkeepingDropped` logs "left a Claude Code bookkeeping file out of a commit"). A file a new Claude Code release starts writing is not on the list, so it raises a "Write outside every claim" card until it is added. The list is `CLAUDE_CODE_BOOKKEEPING`, each entry naming the Claude Code behaviour that writes it. A path joins it only if Claude Code writes it unasked and never reads it back as config or instructions; settings, hooks, agents and skills under `.claude/` stay flagged. A write the builder allowed through the lane's Allow Edit card raises no "Write outside every claim" card (`watcher/allowed-writes.ts`, decision `2026-11-02-a-write-its-permission-card-allowed-raises-no-stray-card.md`): the broker names the file in the card's `detail.path`; an `allow_once` card excuses the next flagged write to that file in the lane's checkout and is then used up, and the write it excused stays excused for that lane only, until its run ends (it survives a restart), and only while the file holds that exact content (mtime, size and sha256) or, for a deletion, stays gone with nothing added to or removed from its directory since (decision `2026-11-02-an-excused-write-stays-with-its-lane-its-run-and-its-content.md`); a file is read to stamp it only when a card or excused write names it; a stored edit rule for the file excuses every write, a step end excuses any file a card allowed the workstream, and a denied card, another lane's or another copy's card, or a write no card allowed still cards.
- **A write outside every claim is a card only for a guardrail path** (`isGuardrailPath` in `strays.ts`: the sensitive
  paths above, any `AGENTS.md` or `CLAUDE.md`, `.github/workflows` and `.github/rulesets`, and lefthook's config).
  Any other path asks nothing, since a commit or a claim over it settles it, so `raise` posts an Activity notice for
  it (`noteQuietStrays`, key `stray-write:<scope>:<path>`, or `…:bulk` for several), once per path and checkout for
  as long as the daemon runs, after the same wait (`strayWaitMs`) and naming the lanes working or the failed run
  that left it. A guardrail path is carded at once, never waits, and `resolveSettledStrays` leaves its card open until
  the builder answers (it still closes an older card of an ordinary path once nothing is left to do). The list is
  for now the paths the spec `2026-11-27-what-reaches-the-builder-design.md` §1 point 3 names that a project holds
  in its own checkout; the full list is a later stage.
- A stray names the run that left it (`watcher/left-by.ts`). A path is left by a failed run when the run is still
  its open task's current run (Retry can pick it up), in the same checkout, named the path as it failed (its failure
  reason, its last handoff's progress, code state or continuity, or a skipped call's summary; relative to the
  checkout or in full, as a whole path), and the file was last written no later than the run's row last changed.
  Such a path gets a card of its own that targets that run, lists it first in `candidates` ahead of the lanes running
  when the write was seen (so `couldBeOwned` still sees them) and says "Left by the failed run of …". The handoff's
  objective is not read: it names the files the run was asked to touch, not the ones it left. A raise of more than
  `LEFT_BY_MAX_PATHS` paths matches none. Any other stray names the lanes running when the write was seen.
- Writes under Your folder's root while a pass holds it are classified by `passAreasOf`, not `project.areas`
  (`forCheckout` in `watcher.ts`), so a pass of one's writes are claimed by its whole-project page and raise no
  stray-write cards. A write outside every claim, such as a hazard file with no claim, is still carded. A copy's
  root keeps `project.areas`.
- **Strays in `.git`** stay sensitive but are narrowed, never muted.
  - **Trust This Version.** A single stray-write card (and a single foreign-claim card, where it reads Keep It)
    carries `sha256`, `root` and `foldKey` in its detail, stamped when the watcher raises it (`flagStamped`), with
    options Trust This Version and Dismiss. A repeat write whose content differs withdraws the open card and raises a new one (not a refresh in
    place, which spec §7.2 names), so an answer to the old card is a `ConflictError` and can never trust bytes the
    builder did not see; the body shows the first 12 hex of the stamp. The same content stays a silent no-op. A file
    that can no longer be stamped replaces a stamped card with an unstamped one. Answering restamps the file in the answer's own
    transaction (`applyTrustChoice`, `inbox/trusted-writes.ts`): a match stores `{ path, sha256, trustedAt }` in the
    app setting `trusted_writes.<projectId>` (zod-parsed on read, newest 500 kept), and a mismatch trusts nothing,
    closes the old card and raises a fresh one with the new stamp (its body no longer names the old version's
    config keys). A file that is still there but can't be stamped (a link, over 32 MiB) comes back as a card with
    no trust option, never closed silently. Files are read through `readSmallFile` (non-blocking, O_NOFOLLOW,
    kind and size from the open descriptor), so a FIFO or link swapped in can't hang the daemon or be followed.
    Trust suppressing a card for a sensitive path is logged at debug. A write that leaves a trusted path holding
    exactly a trusted sha256 raises no card (`withoutTrusted`). Bulk cards, a directory, a link, a deleted file and a
    file over 32 MiB have no stamp and no trust option. There is no Show the Diff: the app has no way to open a
    file's diff from a card.
  - **Checksum.** `.git/info/lefthook.checksum` is excused only at that exact path with content matching
    `^[0-9a-f]{32} \d+\s*$` (`isLefthookChecksum`); any other file in `.git/info` stays sensitive.
  - **Config.** The watcher keeps each config file's text as the builder last decided it (`baseline`) per checkout
    (`.git/config` is read when the checkout starts being watched). A write is diffed key by key with
    `git config --file <copy> --list` through the git wrapper (`Git.configText`) and `changedConfigKeys`, against
    that baseline, which does not advance while a card for the path is open: a second write refreshes the card
    and it still names the first write's keys. The card's stamp is the sha256 of the exact text diffed (one read).
    A config with no baseline (it appeared later, or could not be read at the start) is diffed against an empty
    one, so every non-bookkeeping key is named. A config that is a link, a FIFO, a directory or over 4 MiB raises a
    card saying it could not be read, with no trust option. Only git's own bookkeeping is excused: a branch's
    `merge`, a branch's `remote` when its value names a remote the config defines (a URL or path is carded), and
    `worktree.guessremote`. Every other key, `extensions.worktreeconfig` and the rest of `branch.<name>.*`
    included, raises a card whose body lists the changed keys, lowercase as git prints them. `.git/config.worktree`
    and `.git/worktrees/*/config.worktree` are sensitive and diffed the same way against an empty start.
- **A stray to an ordinary path waits** (`dueStrays`, `strayWaitMs`, 3 minutes unless given): the real-time batch
  holds a write outside every claim to a path that can't change what runs, with the lanes its card would name, and
  one timer per checkout (`recheckStrays`) reads every held path again when the first is due, then is set afresh for
  what still waits, so a batch that fails, or a clock behind its timer, never leaves a path waiting with no timer. It is carded then only if git still reports it, it is still outside every
  claim and allowed by no card, and one of those lanes (or, with none, any of the project's workstreams) could still
  own it, as `couldBeOwned` would judge its card. The step end cards whatever still waits, since it reads every change
  in the checkout. A sensitive path, and a path whose card is already open, card at once. Most watcher tests pass
  `strayWaitMs: 0`, since they test what a write cards, not when.

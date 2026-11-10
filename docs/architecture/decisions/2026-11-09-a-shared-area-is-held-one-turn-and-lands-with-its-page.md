# D17: a pass's shared area is held one turn at a time, kept on the pass's shared chain, and lands with its page

- **Date:** 2026-11-09
- **Amends:** `decisions/2026-10-29-per-copy-hazards-and-waiting-claims.md`, for a pass's shared areas

## Decision

In a Workbench pass an area with `role: shared` is held by a page's turn, never for the task's life. Launch and
the pass's opening never claim it; a lane asks with `request_claim`.

- **The question (W5).** When another task of the pass changed the area during the pass, by a change not
  dropped, or holds it now, the daemon asks the builder before the claim: a `question` on the task, folded by
  task and area (`shared-ask:<workstream>:<area>`), answered Allow, Keep It to This Page, or a reply. The
  agent's `request_claim` waits for it; a call whose four-minute slice ends answers `granted: false,
waiting: true` and the agent calls again with the same opId, which gets an answer that came between
  calls. Allow goes on to the built wait for a holder, then the grant. Keep refuses with the instruction to
  keep the change inside the page. A reply refuses with the builder's words, which are written to the thread
  as a builder message already delivered, since the tool's answer delivers them. Park the task answers as
  Keep, never parking a page, and the thread says so. The question is not a decision. A question is withdrawn,
  and its wait ends with nothing, once the lane's turn has ended, so an area is never granted to a page
  between turns; a reply that comes after the turn ended is written undelivered and starts the next
  turn. A question left when the daemon stops is withdrawn at start-up, and the agent asks again.
- **The grant.** The claim's synchronous look stays as built, so a held claim names its holder before the
  wait is joined. A free claim is granted by recording, in an unsigned commit on the chain's tip, every
  shared file of the area that differs from that tip, with its content, then writing the claim and its hold,
  numbered on the chain, in one write; a task that took the claim between the two is the conflict and
  nothing is written. A file under a page area of the pass, under an area a pass task holds as a page, or
  under a hazard a pass task holds is never in a record or a change.
- **Keeping.** At every turn's end (Ready, stopped, failed) and before a usage pause, step 2 keeps each open
  hold: a shared file whose content on disk differs from the record (which holds the chain's tip for every
  file it did not record) is in the change, whole, and the change is one unsigned commit on
  `refs/10db/passes/<pass>/shared` by compare-and-swap, its row upserted, the hold closed and the claim
  released in one write, with a line on every other page's thread. A hold that changed nothing makes no
  commit. The commit tool keeps a hold early and leaves it open. At start-up every hold a stop left open is
  kept and released, and a lost hold ref is remade from its row.
- **Landing.** Each page's kept work records the highest number granted when its turn ended. Sign-off lands
  the chain in number order up to what the page needs, one signed commit per change on the pass's branch,
  passing over empty holds, dropped changes and drops; slice 6 provides it (`landSharedChanges`) and slice
  7's sign-off calls it.
- **Drop.** A take-out may drop a change of its page that has not landed, newest first: each file is written
  back, hashed again just before, to the hold's record (the builder's edit from before the grant, else the
  chain's version before the change, else removed), and a drop is appended to the chain. It is refused while a
  later change touches the files or one changed on disk. An Abandon drops every unlanded change with no
  refusal but the hash before each write, and names any file it left.

## Why

One folder has one copy of each shared file, so a change to one is a change to every page; the builder
decides whether it is meant for every page (W5). Holding the area one turn at a time puts the changes in the
order the folder saw them, and the record taken at the grant keeps the builder's earlier edits and dirt from
before the pass out of a task's change. Landing a prefix of the chain, by number, keeps the branch's shared
files a state the folder was in, whichever of two areas' holds ended first.

Turned down: holding a shared area for the task's life, which would let one page block every other; asking
the builder on every request, including the first; landing a shared change when its turn ends, which would put
work nobody signed off on the pass's branch; writing a drop's files from the blobs alone, when the hold's
record commit already holds each file's content and mode and the built restore hashes before each write.

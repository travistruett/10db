# State × event table: a stakeholder question card and its send

The send lifecycle's states, events and outcomes, as built: each cell a test row in the task it cites. It
was written before the build from the plan as merged in #578, and the build followed it where the two
disagreed; the plan and spec now say the same. Rulings by the coordinator and the builder on 2026-11-12.
`[7c]` cites a plan task, `[§8.6]` a spec section.

## The builder's decisions after the plan was written

- **Replies count wherever people type.** In the live Slack check, a business stakeholder answered at the top
  level of a group DM despite an @-mention asking for a thread reply. Top-level and in-thread replies are equal:
  - A top-level message joins the conversation of that person's open send in `ts` order, and the normal state
    rules apply (ruling 2).
  - With two or more open sends, a new judge decision **`reply_match`** (Choice over the person's open questions
    plus `unclear`, floor 0.8, logged like `question_route`) picks the send. Below the floor, or with no key,
    10db posts "Which one is this for? 1) … 2) …" in that DM, and a reply with a number assigns it.
- **No thread instruction and no nudge.** The "↳ Reply in this thread…" line and the one-time nudge
  (`topLevelNudgedAt`) are dropped. A question ends with "Reply with A, B, or your own words." `replyVia` stays
  as a stored field.
- **Approvals are judged, not matched word for word.** With a proposal open, a new judge decision
  **`approval_read`** (Noul: does this reply approve proposal X?, floor 0.8) reads a recipient's reply, so
  "Yes sir" approves. With no key, the fallback is a loose list, case-insensitive, punctuation and trailing
  words like "sir" ignored: yes, yep, yeah, sure, ok, okay, approve(d), sounds good, go ahead, do it, 👍, ✅.
  A ✅ reaction still approves.
- All three decisions keep provider parity: they read only the card and Slack.

## Row keys

| Key | State |
|---|---|
| P | card OPEN, `routedBy: triage_pending`, no send |
| Dr | draft, card OPEN, session parked; `heldBy` ∈ review / first_send / limit / scan |
| Sg | send `sending` |
| W | sent, no reply yet |
| D | sent, discussion not settled (a non-lone speaker, or a tie) |
| L | lone reply pending its quiet tick (`loneReplyPendingSince` set) |
| Pr | settled, proposal open (bot's ✅ seeded) |
| As | `approval_seen` |
| WW | which-way line asked |
| Mv | mid-move: group DM opened or reposted, `moveSend` not written |
| Gd | moved to a group DM; otherwise as its source state |
| Rm | reminded |
| Rt | returned by timer |
| Rd | returned as disagreed |
| An | answered |
| Cb / Ct / Cc | closed: builder answered / taken back / cancelled |
| F | failed |

"W…Rd" means every sent state from W through Rd.

## A. Slack messages and reactions

| | Recipient's thread reply | Top-level reply | Other participant's reply | Mention of non-participant | ✅ added by recipient | ✅ removed | Bot's own ✅ |
|---|---|---|---|---|---|---|---|
| P, Dr | impossible | not this card's (r1) | impossible | impossible | impossible | impossible | impossible |
| Sg | read once sent; cursor starts at the question's `ts` [2, 8b] | counts once `sent` [8c] | impossible | handled once sent [8e] | n/a | n/a | n/a |
| W | lone → L, writes `loneReplyPendingSince` [5, 8b, 8d]; tie → D | joins the send's conversation (r2); several open → `reply_match` | 1:1 impossible [§8.4]; tie or moved → D | bring-in: group DM, repost, moved line, `moveSend` → Gd; >8 → the full line; refused open → the couldn't-add line [8e] | ignored (no proposal) | ignored | impossible |
| D | extends; a tie's letter with nothing newer from another recipient after a tick → picked → An; different letters → Rd [5, §8.6] | r2 | extends | → Gd [8e] | ignored | ignored | impossible |
| L | joins, waits another quiet tick (r3) | r2 | → D | r4 | ignored | ignored | impossible |
| Pr | `approval_read` yes → As; a letter → picked → An; else withdrawn → D [5, 8f] | r2 | withdraws → D (r7 applies only to As) | r5 | on the proposal → As (`approvalSeenAt`, `approvalBy`); a non-recipient's, or one on another message: ignored | nothing | ignored (bot id dropped) |
| As | another recipient → Rd; the approver again: r6 | r2 | r7 | r5 | credit stays with the first in routing order | `approval_lost` → Pr, the proposal kept | ignored |
| WW | lone: lone reply after a quiet tick → option or own words, quoted → An [8f]; tie: as D | r2 | → D; settles only on messages after `settledThroughTs` | → Gd | ignored | ignored | impossible |
| Mv | lands in the old thread, read next tick | as W | as the source state | after the move | as the source state | as the source state | as the source state |
| Gd | as the source state; reads the group DM and `moved_from`; a reply counts once [8e] | as the source state | as the source state | new group DM with everyone; >8 → the full line | as the source state | as the source state | as the source state |
| Rm, Rt | as W or D; a reply still answers → leaves Open → An [§8.1] | as W | as W or D | as W | as W or D | as W or D | as W or D |
| Rd | r8 | r2 | → D | → Gd | ignored | ignored | impossible |
| An, C*, F | not read (out of `openSends`); a follow-up send reads after its own `ts` [§7.4] | r1 | not read | not read | not read | not read | not read |

## B. Ticks, judge and timers

| | Quiet tick | Judge answers | Judge times out or errs | Remind due | Return due |
|---|---|---|---|---|---|
| P | n/a | 3b outcomes in one write, `inbox.triaged`; routed → `afterRouted` (draft [7a], park [6]); a card no longer OPEN only leaves pending; r9 | fallback: topic, then category; `routedBy: rule` | impossible | impossible |
| Dr, Sg | n/a | n/a | n/a | n/a (timers start at `markSent`) | n/a |
| W | nothing | n/a | n/a | connected: `reminderLine`, `markReminded` re-checked in its write → Rm; not connected: owed, posted on reconnect unless returned (r21: metadata) | `markReturned(timer)`, no Slack → Rt; both due → return only |
| D | a letter plus a quiet tick, or 30 min quiet, with a message after `settledThroughTs` → `thread_answer` | ≥ floor: proposal line, `addReaction`, write proposal and `settledThroughTs` → Pr; else which-way → WW; r10 | which-way line → WW | as W | as W |
| L | `lone_reply` → `answerAs`, `markAnswered(replyVia)` and the cursor in `inTx` → An; a decision only for an option; quoted prompt [8a, 8b] | n/a | n/a | r11 | held one tick if `loneReplyPendingSince` predates due; else → Rt, and the reply still answers |
| Pr | waiting, nothing posted | n/a | n/a | as W | → Rt, proposal kept; a later approval still answers |
| As | still stands and no other recipient wrote → `answerAs(approved, with)` → An | n/a | n/a | as W | r12 |
| WW | waiting, nothing posted | n/a | n/a | as W | as W |
| Mv | the next tick finishes the move by metadata search | n/a | n/a | posted in the current thread | as W |
| Gd | as the source state | as the source state | as the source state | posted in the group DM | as W |
| Rm | as W | n/a | n/a | none | as W |
| Rt, Rd | Rd: settle rules on new messages | n/a | n/a | r13 (fixed: none) | none |
| An, C*, F | n/a | n/a | n/a | n/a | n/a |

## C. Builder actions

| | Builder answers | Keep Waiting | Send | Send Anyway | Ask Someone / reroute | Take Back | Card cancelled or withdrawn |
|---|---|---|---|---|---|---|---|
| P | answered as today; triage only leaves pending | 409 | 409 (r17) | 409 (r17) | r9 | 409 | CANCELLED; triage only leaves pending |
| Dr review / first_send | answered via `onParkedAnswer`; the draft closes (r14) | 409 | rescan, `markSending` → Sg, post, `markSent` → W | as Send | drop the draft, re-set, new draft, `parkFor`, `afterDraft` | `closeSend(taken_back)`, nothing posted | CANCELLED; the draft closes (r14) |
| Dr limit | as above | 409 | refused without `overrideLimit` | → Sg; counts once sent | as above | as above | as above |
| Dr scan | as above | 409 | refused while held; an edit that clears → Sg | refused (never bypasses a hold) | as above | as above | as above |
| Sg | answered; closes `builder` once the post lands, then the closing line | 409 | 409 | 409 | r19 | closes once the post lands, then the take-back line | closes once the post lands, then "no longer needed" |
| W, D, L, WW, Gd, Rm | first answer wins: `closeSend(builder)`, the closing line in every thread used; a later reply does nothing | r16 (409) | 409 | 409 | r19 | the take-back line in every thread; card back in Open | "no longer needed" in every thread |
| Pr, As | as W; a later ✅ does nothing | r16 | 409 | 409 | r19 | as W | as W |
| Mv | r15 | r16 | 409 | 409 | r19 | r15 | r15 |
| Rt | as W | clears the return and the reminder, `waitStartedAt = now` → W | 409 | 409 | r19 | as W | as W |
| Rd | as W | as Rt; the disagreement stays in the thread | 409 | 409 | r19 | as W | as W |
| An | 409 | 409 | 409 | 409 | impossible | 409 | impossible |
| Ct | the builder's card: answered as today, no line | 409 | 409 (r17) | 409 (r17) | new send allowed (r18) | 409 | CANCELLED, nothing posted |
| Cb, Cc | impossible | 409 | 409 | 409 | impossible | 409 | impossible |
| F | answered as today, nothing posted | 409 | new send allowed (r18) | as Send | new send allowed (r18) | 409 | CANCELLED, nothing posted |

## D. The lane

| | Session asks or waits (`onWaitStart`, folded ask included) | Session parked or ended | Task cancelled |
|---|---|---|---|
| P | waits live as a builder card; parked via `afterRouted` → `parkFor` if routed away | parked at `humanWaitMinutes`; the answer arrives via `onParkedAnswer` | sole target → CANCELLED (as column C); else the card stays |
| Dr, Sg, W…Rd | re-reads the card; recipients aren't the builder → parks at once, even with another wait open [6] | nothing changes; the answer arrives via `onParkedAnswer` | sole target → CANCELLED → the cancel column; else stays, nothing posted |
| Ct, F | the builder's card: waits live | as above | as above |
| An, Cb, Cc | impossible | — | not OPEN: nothing |

## E. Restarts, connection and sleep

| | Crash between a Slack post and its write | Token removed (`none`) | Token refused | Unreachable | Mac wakes after hours |
|---|---|---|---|---|---|
| P | no post; `sweepDrafts` at start settles to the fallback | no effect | no effect | no effect | the judge's 4 s timeout (injected clock) → fallback |
| Dr | no post; the draft survives | r25 | r25 | r25 | the draft stays held past the limit window |
| Sg | `recoverSending` finds by metadata → `markSent`; none → posts (r20) | the post fails `no_token` → `failSend` (r25) | refusal → `failSend` → card to the builder | r25 | the fetch times out (r25) |
| W, Rm | the reminder: r21 | the watch stops; card in Open with the notice; the return still fires; the reminder is owed | as removed, refused card | after 3 failed ticks `unreachable`; card in Open; the return fires | the wake tick reads replies since the cursor once; both due → return only |
| D, Pr, WW | the line is found by metadata, not reposted; a lost `addReaction`: r22 | as W | as W | as W | D: 30 min passed → settles → judge; Pr: a ✅ added during sleep → As |
| L, As | no post; the marks persist | as W | as W | as W | L: answered (the return held a tick); As: confirmed if the ✅ stands |
| Mv | the repost is found by metadata; `moveSend` uses its `ts`; the moved line: r23 | as W | as W | as W | as W |
| Rt, Rd | the return posts nothing | as W | as W | as W | replies read; a pick answers |
| An | `recoverOnStartup` redelivers | — | — | — | — |
| Cb, Ct, Cc | a lost closing line: r24 | — | — | — | — |

## Rulings (each is a test row in the task named)

1. **Top-level reply with no open send** [8c]: advance the contact's cursor and ignore it.
2. **Top-level reply with an open send in D, L, Pr, As, WW or Rd** [8c]: merge the message into that send's
   conversation in `ts` order and apply the state rules. Answer outright only for a lone 1:1 send in W or L.
   Several open sends: `reply_match` first.
3. **More messages during L** [5]: keep `loneReplyPendingSince` at its first value.
4. **A mention inside a pending lone reply** [8e]: bring-in first, then → D.
5. **A move with a proposal open** [8e]: `moveSend` clears the proposal and approval marks; settle again in the
   group DM.
6. **The approver writes during As** [8f]: a letter → picked; an approval → stays As; anything else clears the
   approval and withdraws the proposal.
7. **A non-recipient writes during As** [8f]: doesn't block (Priya can't veto Mark). Amend spec §8.5.5.
8. **A letter in Rd** [5]: counts only when every recipient's latest letter agrees, or through a new proposal
   a recipient approves.
9. **Ask Someone while triage is pending** [3b]: triage writes only if `routedBy` is still `triage_pending`;
   otherwise it records just the judge outcome.
10. **The judge returns after the card closed** [8f]: re-read the send after the judge; post only if still `sent`.
11. **Reminder due during L** [8d]: held one tick, like the return.
12. **Return due during As** [8d]: held one tick.
13. **Bug fix** [8d]: `dueTimers` returns `none` whenever `returnedAt` is set; extend the 3h→10h row over later
    ticks.
14. **A draft whose card is answered or cancelled** [7c]: close it in the same write (`builder` / `cancelled`),
    nothing posted.
15. **Answer, Take Back or cancel during Mv** [8e]: on the `moveSend` conflict, post the closing line in the new
    group DM too.
16. **Keep Waiting** [8d]: 409 unless the card has returned.
17. **Send with no draft** [7b]: 409.
18. **Sends unique only among `draft`, `sending` and `sent`** [2]: after Take Back or a failure, Ask Someone
    makes a new send. This changes Task 2's unique index; it stays in the same generated migration.
19. **Ask Someone on a sending or sent card** [7b]: 409 "Take it back first".
20. **Crash recovery is found by `tendb_send` metadata** [7b]: amend spec §7.5 (not the text hash).
21. **The reminder carries `tendb_send` metadata** [8d] and is searched for before posting.
22. **A found proposal missing its seeded ✅** [8f]: add it; `already_reacted` counts as success.
23. **Crash before the moved line** [8e]: search the old thread for its metadata and post it if missing.
24. **A lost closing line** [7c]: accepted for slice 1; a follow-up.
25. **Sending without a working connection** [7b]: no token at Send → 409 and the draft stays; `no_token` or a
    refusal at the post → `failSend`; `unreachable` or a timeout mid-post → stay `sending` and run the metadata
    search on the next good tick, not only at start.

## Rulings made during the build

These came from the build's reviews and the builder; the code and its tests follow them.

26. **Another recipient agreeing during As** [8f]: an approval or the same letter from another recipient keeps
    As; anything else → Rd.
27. **A recipient's later message takes back their letter** [5]: a pick needs a quiet tick with nothing newer
    from another recipient after the first letter, so "not sure, what does B cost us?" leaves it to the settle
    rules. Mark "B", Ana "hmm", Ana "B" then settles through the proposal and a ✅.
28. **A bare "A" is a letter only when alone or before punctuation** [5]: "A couple of questions…" is not a pick.
29. **Each send's window ends at the next question in that thread, in any state** [8b]: an answered follow-up
    still bounds the question before it, in the current thread and the one a send moved from.
30. **Top-level matches persist** [8c]: what each top-level message was assigned to and the "Which one is this
    for?" lines live in the app setting `stakeholder-reply-match`, so a restart neither re-assigns a used
    message nor asks again.
31. **A conversation that's gone fails only its own sends** [8b]: `thread_not_found`, `channel_not_found`,
    `message_not_found`, `is_archived` and `not_in_channel` fail those sends and return their cards to the
    builder. Every other error, Slack's temporary ones and a reply that isn't JSON included, counts like
    `unreachable` for the whole tick.
32. **The builder's name** [7a, 10]: connecting Slack ends with "Which one is you?", which binds the builder's
    person to their Slack member and takes its name. Send answers 409 "Set your name in Settings › People"
    while the builder is still the seed "You", and an unedited draft is composed again at Send, so it carries
    the current name. A builder's edit is kept on the draft even when the Send fails before posting.
33. **Send on a failed card** [7b]: drafts again for the same recipients (row F).
34. **Slack words in lane prompts are quoted data** [8a, 9, §8.1]: answers given in Slack reach reviewers in
    their own section ("Mark answered in Slack"), never as the builder's; names, notes and conversations in the
    resumed prompt, `get_context` and knowledge go through one quoting function and are capped.
35. **Only one moved-from thread is kept** [8e]: after a second move a reply left in the original DM is not
    read. A follow-up.

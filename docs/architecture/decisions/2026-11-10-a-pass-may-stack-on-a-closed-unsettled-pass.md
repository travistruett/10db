# A new pass may stack on a closed, unsettled pass, and a local pass's record pull request does the same

- **Date:** 2026-11-10
- **Amends:** `decisions/2026-10-29-shared-checkout-switch-back.md`

## Decision

Opening a pass while another of the project is `CLOSED` and unsettled stacks the new one on the newest such
pass (`passes.stacked_on`, `delivery/pass-stack.ts`, `stackOn`): the same return branch, its start at the
closed pass's tip, and its pull request based on the closed pass's branch while that one's is open
(`passPrBase`). The closed pass's Move card is withdrawn while the stacked pass is open or closing and comes
back if the stacked pass is abandoned at its start; the stacked pass's close moves the return branch on from
that tip. When the lower pass's pull request merges, it settles, the stacked pull request is retargeted on
the base, and with the base's tree equal to the lower tip the base comes into the stacked branch by one merge
commit whose tree is its own (call 34); with drift it is only retargeted and a header notice says its pull
request lists the lower pass's commits. Closed unmerged, the stacked pass offers Retarget (call 35). A pass
that stacks on one whose merge was read already follows that merge at once.

On a `local` project every pass settles at its close, and a new pass continues on the same branch at the
folder's HEAD. It records the newest settled pass as `stacked_on` only while that pass's record pull request
is open, so its own record pull request takes that pass's branch as its base; the record's merge retargets
it on the base, and a close unmerged offers Retarget, as above.

## Why

Workbench spec §5.3, D24: waiting for a merge before the next pass would stall the builder for a review
cycle, and a pull request based on the base would show the closed pass's work again. One pointer per pass
keeps a third pass stacking the same way. On a `local` project the spec's sentence "it takes A's branch as
its base in the same way" needs the pointer too; the alternative reading, finding the pass below by its
branch at Open Pull Request time, needs git in a read the database answers today. Turned down: refusing a
pass while one is unsettled, and basing every pass on the base.

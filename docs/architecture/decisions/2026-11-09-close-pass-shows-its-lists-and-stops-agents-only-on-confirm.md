# D25: Close Pass… shows its lists without stopping anything, and closes only on the lists it showed

- **Date:** 2026-11-09

## Decision

`GET /passes/:passId/close` (`pass/close-lists.ts`, `pass/unowned.ts`) stops nothing. It lists the unfinished
pages, each marked working while its turn is open, with its shared changes that have not landed and why Drop is
refused for one; the files in Your folder that differ from the pass's branch and that no unfinished page owns or
a kept shared change holds, each with its lines added and removed and marked when it is the dirt the pass opened
on; the commits on the pass's branch that carry no 10db operation id; one summary line; where the gate runs and,
for the folder, what its failure costs; and a token over the lists, which leaves out who is working.

`POST /passes/:passId/close` refuses (409) a pass that is not open, Your folder off the pass's branch, and choices
the lists do not allow. Otherwise it stops every unfinished page's agent, builds the lists again and, when their
token differs from the one confirmed, answers them with one line per difference and closes nothing. When it
matches, one write keeps the request as the close's plan (`close_plan`), makes the pass `CLOSING` at step 1 and
ends every waiting sign-off; the close job then runs.

## Why

The builder's decision D25: opening the modal and cancelling must cost no agent its turn, and a page must not be
taken out or signed off on lists a stopped turn changed. A token that counted who was working would always
differ after the stop, so the modal would ask again every time. Turned down: stopping the agents when the modal
opens (a Cancel costs every running turn), and closing on whatever the lists are after the stop (a file the stop
wrote would be left out or placed without being seen).

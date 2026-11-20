# Task 8: the e2e — New Plan through Accept

**Spec:** §10 Build order, item 1 (the e2e); the Brief's "What could go wrong". **Track:** B. It needs Tasks 5-7 on
the branch. Read `apps/desktop/e2e/AGENTS.md` once.

## Files

- **`apps/desktop/e2e/sessions.spec.ts`**: one new `test(…)`, after the existing ones. The specs run in name order
  with one worker, and the fake's script is Task 4's.
  1. Open New Plan from the Sessions panel's + menu, then once more with ⌘⇧N. Both open a session with the Plan
     panel open and empty.
  2. Drop `notes.vtt` (`.vtt` is on today's allowlist; files by content are slice 5), and send "Here is what I
     heard". The reply ends "I have notes.vtt.", and Heard so far shows the echoed items.
  3. Send "propose it". The panel shows the scripted plan: the "Board polish" goal with two tasks, two loose tasks
     and one decision.
  4. Move through the rows with ArrowDown and ArrowUp, and open one in place with Enter, as `shape.spec.ts` lines
     88-98 do.
  5. Pin a loose task by editing its title, then send "propose again". The pinned title survives the round.
  6. Accept. There is one goal, so no cut list. The Board shows the goal and its tasks, and the panel's rows read as
     converted.
  7. Run Remove Draft Goal from the goal's menu. The goal and its tasks leave the Board, and the goal is proposed
     again, as `shape.spec.ts` lines 112-120 check.
  8. Run axe on the panel side by side, then resize the page under the side-by-side width and run it on the drawer
     (`expectAccessible`, as `shape.spec.ts` does).
  9. Reload. The session reopens with its panel open.
- **`apps/desktop/e2e/shape.spec.ts`**: delete it.
  - Steps 2-8 cover its talk, propose, convert, row keys, Remove Draft Goal and axe.
  - Its Propose keys (⌘⇧↩) go with the Propose button.
- **`apps/desktop/e2e/see-screen.spec.ts:66-101`**: the Plan picture comes from a New Plan session ("see the plan"
  sent there), not from `goto('/shape')`. The label stays "Plan at 1000×900".
- **`apps/desktop/e2e/window-csp.spec.ts:123`**: the fenced reply comes from "show a fence" sent in a New Plan
  session, not from `/shape`.
- **`apps/desktop/e2e/shape-project.ts`**: keep the helper's name; five specs import it.

## Tests

The e2e is the test for the user-visible slice. Run it with the repo's command for one spec
(`apps/desktop/e2e/AGENTS.md`). Never run the whole e2e suite on the Mac; CI runs it.

## Steps

1. Write the new test against the branch and run it alone. See it pass, then break one assertion and see it fail.
2. Move the `see-screen` and `window-csp` rows, and delete `shape.spec.ts`.
3. Commit: `test(desktop): new plan runs from a dropped file to accept in a session`.

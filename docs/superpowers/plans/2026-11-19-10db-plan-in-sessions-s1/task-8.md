# Task 8: the e2e — New Plan through Accept

**Spec:** §10 Build order, item 1 (the e2e); the Brief's "What could go wrong". **Track:** B. It needs Tasks 5-7 on
the branch. Read `apps/desktop/e2e/AGENTS.md` once.

## Files

- `apps/desktop/e2e/sessions.spec.ts`: one new `test(…)`, after the existing ones. The specs run in name order
  with one worker. The flow:
  1. New Plan from the Sessions panel's + menu, then once more with ⌘⇧N; check both open a session with the Plan
     panel open and empty.
  2. Drop a small text file (`notes.vtt`, under the allowlist as it stands; files by content are slice 5). Then
     send "Here is what I heard; propose it". The fake reads the file path from the intake line and proposes; on
     the first message it echoes with `note_heard`, so Heard so far shows first.
  3. The panel shows the scripted plan: the "Board polish" goal with two tasks, two loose tasks and one decision.
  4. Pin a loose task by editing its title. Send another "propose"; the pinned title survives the round.
  5. Accept with the cut list unneeded (one goal). The Board shows the goal and its tasks, and the panel's rows
     read as converted.
  6. Run axe on the panel side by side and as a drawer: resize the page under the side-by-side width. Use
     `expectAccessible`, as `shape.spec.ts` does.
  7. Reload; the session reopens with its panel open.
- `apps/desktop/e2e/shape.spec.ts`: delete it. Its talk, propose and convert path is step 2-5 above, and its axe
  check is step 6.
- `apps/desktop/e2e/see-screen.spec.ts:66-101`: the Plan picture is taken from a New Plan session, not
  `goto('/shape')`. The picture's label stays "Plan at 1000×900".
- `apps/desktop/e2e/window-csp.spec.ts:123`: the fenced reply comes from a New Plan session's message ("show a
  fence"), not `/shape`.
- `apps/desktop/e2e/shape-project.ts`: the helper's name stays; it is imported by five specs.

## Tests

The e2e is the test for the user-visible slice. Run it with the repo's e2e command for one spec
(`apps/desktop/e2e/AGENTS.md`). Never run the whole e2e suite on the Mac; CI runs it.

## Steps

1. Write the new test against the branch. Run it alone, see it pass, and break one assertion to see it fail.
2. Move the `see-screen` and `window-csp` rows, and delete `shape.spec.ts`.
3. Commit: `test(desktop): new plan runs from a dropped file to accept in a session`.

---
name: handoff
description: Use when 10db asks you to hand off, or when your context is nearly full.
---

# Handoff

A fresh session continues your work from what you write. Make it able to start in one
step.

1. Finish the logical step you are in: get the tests passing and commit with
   `mcp__10db__commit`. Don't start anything new.
2. Call `mcp__10db__write_handoff` with all six parts:
   - **objective:** the task, its acceptance criteria and the non-goals;
   - **progress:** what is done, what is not, and the single next concrete action;
   - **code state:** a summary of anything uncommitted (10db adds files and commits
     from git itself);
   - **reasoning:** decisions, trade-offs and approaches you rejected, with why;
   - **validation:** checks you ran, their results and any environment problems;
   - **continuity:** blockers, pending questions, background jobs, and anything the next
     session must know that isn't in the code.
3. Be specific: name files, functions and commands. "Continue the work" is not a next
   action; "Add the 409 case to `answerInbox` in `src/api/app.ts` and its test" is.
4. After the handoff is recorded, end your turn. 10db starts the next session.

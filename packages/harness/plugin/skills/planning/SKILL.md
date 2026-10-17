---
name: planning
description: Use when a task needs more than one small change, before you edit any file.
---

# Planning

Plan before you touch code. The plan is for you and for the session that may continue
your work after a handoff.

1. Restate the task and every acceptance criterion in your own words. If a criterion is
   ambiguous and the choice matters to the product, ask with `mcp__10db__ask_human`
   (2-4 options, with your recommendation). Don't guess on product questions.
2. Call `mcp__10db__get_context` and `mcp__10db__find_knowledge` for decisions that
   already answer your questions. Follow recorded decisions; if you must depart from one,
   call `mcp__10db__report_deviation` with a signed reason.
3. Read the code you will change and its tests. Name the files you expect to touch.
   Every path must sit inside your claims; if not, call `mcp__10db__request_claim` first.
4. Split the work into steps that each end with a passing check and a commit. Prefer
   several small commits over one large one.
5. Write the plan as a short numbered list in your reply, then start step 1.

Record routine engineering choices (library call, file layout, naming) with
`mcp__10db__record_decision` so nobody has to ask again.

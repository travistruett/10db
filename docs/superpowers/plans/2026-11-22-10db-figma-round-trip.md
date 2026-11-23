# Plan: Open in Figma and Bring Back from Figma on a Plan mock-up

**Size:** Feature (10db's Standard): two buttons on a mock-up, two 10db MCP tools, two `app_settings` keys, one
Settings card. No migration, no new table, no new dependency. One implementer end to end; one review after a
click-through; extend one e2e flow.
**Evidence:** the live round trip of 2026-11-22 (`~/Agents/notes/10db/2026-11-22-figma-round-trip-progress.md`)
and the research note beside it.

## Brief

**What changes for you.** A mock-up in a Plan gets **Open in Figma**. Pressing it asks the Plan's agent to send
that mock-up to a draft file in your Figma, and the mock-up then shows a link to its frame. Once you've edited the
frame, **Bring Back from Figma** asks the agent to read it and file it as a new version of the mock-up. You can
approve that version, and Design Review compares against it as with any other. Settings › Integrations gets a
Figma card under "Through Your Agent", saying how each account reaches Figma and where to sign in.

**What it buys.** You can design in Figma and have the build use the result, with no copying of links or HTML by
hand.

**What could go wrong, and how we'd know.**
- **The agent's Figma server isn't connected** (signed out, Gateway account, Trust switch off). The agent says so
  in the Plan and nothing is filed.
- **The returned HTML drifts from the frame.** You see it on the new version's thumbnail beside the frame, and you
  don't approve it.
- **Figma's read limit** (small on Starter, 200 a day on Professional). Bring Back costs one read, so the limit
  shows up as the agent's error in the Plan.

**Calls you might disagree with.**
- **10db's daemon, not the agent, POSTs the mock-up to Figma.** `html_to_figma` returns a one-time upload URL. In
  a Plan session the agent's `curl` would stop on a card, and Figma's host may not be on the sandbox's network
  list. So the agent passes the URL to a 10db tool, and the daemon posts that mock-up's stored HTML.
  - The daemon posts only to `https://mcp.figma.com/mcp/html_to_figma/…/submit` and holds no Figma credential.
  - What leaves the Mac is the mock-up you pressed the button on, and nothing else.
- **The agent, not 10db, turns Figma's React + Tailwind into plain HTML.** Compiling Tailwind in the daemon would
  add a native dependency. 10db only inlines Figma's asset URLs, because their links die in 7 days.
- **One draft file per project**, holding a page per send.
- **No per-project switch.** You start every send yourself; the Trust switch for your MCP servers turns it off.

**Needed from you:** nothing until the screenshots of the two buttons.

## Provider parity

- **Claude plan, Bedrock and API key:** the session uses your own Figma sign-in (the plugin as
  `plugin:figma:figma`, fixed in #745).
- **Codex:** the same tools, signed in through Settings › Trust once 10db-a2's Sign In change (sign-in blocked
  only by an `Authorization` header) lands. Until then the agent reports Figma as not connected, and the card
  says to sign in there.
- **Claude Gateway:** OAuth servers don't run there yet (the 2026-11-14 decision), so the card and the agent say
  Figma isn't available.

## Parts

1. **Frame links (daemon + contracts).**
   - `app_settings` key `figma-frame.<attachmentId>` holds `{ fileKey, nodeId, fileUrl }`.
   - `app_settings` key `figma-file.<projectId>` holds `{ fileKey }`.
   - Both have zod schemas in `packages/contracts/src/figma.ts`. A malformed value reads as absent.
   - `ShapeAttachmentDto` gains `figma: { fileUrl } | null`, set only for a mock-up.
2. **Two 10db MCP tools for Plan sessions** (`shape/tools.ts`, `mcp/shape-tools.ts`, contracts).
   - **`send_mockup_to_figma { attachmentId, submitUrl }`.**
     - Checks that the attachment is this Plan's mock-up, and that `submitUrl` is `https://mcp.figma.com/` with a
       path matching `/mcp/html_to_figma/<uuid>/submit`. Anything else is refused.
     - POSTs `mockupDocument(html)` as `text/html` with a 60 s timeout, then parses `{ success, fileUrl, nodeIds }`
       with zod.
     - Stores the frame link (the first node id) and the project's file key. It returns the link and writes a
       transcript tool line.
   - **`file_figma_version { attachmentId, html }`.**
     - Refuses an attachment that has no frame link.
     - Replaces every `https://www.figma.com/api/mcp/asset/<id>.(svg|png)` in the HTML with a `data:` URI. It
       fetches each with a 20 s timeout and at most 5 MB, and refuses the version if one fails.
     - Inserts a new mock-up row on the same key and target through `attach`'s path, copies the frame link to the
       new row, and returns it.
   - Both use an injected `fetch`, with the real one as the production default. Under `TENDB_FAKE_SCRIPTS`,
     `main.ts` wires a fake Figma `fetch` the way it wires the fake adapter (`chooseAdapter`).
3. **Two buttons (daemon route + desktop).**
   - The route is `POST /shapes/:shapeId/attachments/:attachmentId/figma { action: 'open' | 'bring-back' }`.
   - It writes a Note and a prompt and queues it, like Review (`shape/service.ts:670-690`, `chat/hooks.ts`
     `deliverable`).
   - **Open's prompt** names the attachment, its key and the stored file key, if any. It tells the agent to:
     - call `whoami` and `create_new_file` (a design file named "<project> mock-ups" in your one plan) when no
       file is stored, otherwise use the stored one
     - call `html_to_figma` with that file key and `cssSelector` unset
     - call `send_mockup_to_figma` with the returned `submitUrl`
     - reply with the link in one line
   - **Bring Back's prompt** gives the stored file key and node id. It tells the agent to:
     - call `get_design_context` on them (one read; its screenshot is the target)
     - turn the code into one self-contained HTML document with inline CSS: no scripts, no external URLs except
       Figma asset URLs, fonts mapped to the mock-up's system stack
     - call `file_figma_version`
   - In `row-attachments.tsx`, a mock-up gets **Open in Figma** (or **Send Again to Figma** once linked) and, once
     linked, **Bring Back from Figma** plus the frame link.
   - The frame link opens through `POST /shapes/:shapeId/attachments/:attachmentId/figma/open`. The daemon opens
     the stored `fileUrl` with `/usr/bin/open`, as `codex-mcp-sign-in.ts` does, and only for an
     `https://www.figma.com/design/…` link. The window never opens a page itself.
4. **The Figma card.** `daemon/figma-sign-ins.ts` mirrors `linear-sign-ins.ts`: a server by host `mcp.figma.com`,
   a connector by `/figma/i`, and an unchecked account counted as a maybe. It is served at
   `GET /settings/sign-ins/figma` and shown as `FigmaCard` under "Through Your Agent", with the Linear card's
   states and no switch.
5. **Notes.** `shape/AGENTS.md` and `views/settings/AGENTS.md` get the tools, keys and card.

## Tests

- **No new unit tests.** Nothing here is core under `.claude/rules/testing.md`. The `submitUrl` and asset-host
  checks are input validation on 10db's own tool, covered by the e2e and by review.
- **Extend the Plan flow in `apps/desktop/e2e`.** Give `scriptedShapeBehaviour` a "figma" trigger that calls
  `send_mockup_to_figma` and `file_figma_version` as the agent would, with the fake Figma `fetch`
  answering as Figma did on 2026-11-22. The flow then:
  1. presses Open in Figma and sees the frame link
  2. presses Bring Back from Figma and sees a second mock-up version, with a `data:` image where the asset URL was
- **Live check before merge:** one real send and Bring Back from a dev build, on the builder's Figma.

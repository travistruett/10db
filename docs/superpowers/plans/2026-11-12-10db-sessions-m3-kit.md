# Sessions M3: the static conversation kit: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/desktop/src/conversation/` gains `Markdown`, `ToolCallCard` (with per-hunk `Diff` and 10db's own
gutter) and `ConversationList`. Plan's transcript renders its stored messages through them, so Plan's replies
render as hardened markdown. Links in agent markdown open after a confirm.

**Architecture:**

- The kit renders a desktop view model, `ConversationEntry`, not a wire DTO. Plan maps its `ShapeMessageDto`s to
  entries. M4b maps `ConversationItemDto`s to the same type.
- `Markdown` is the only place streamdown is configured: raw HTML skipped, rehype-sanitize, then rehype-harden with
  no images and `https:` links only. Every element is a Mantine component, and fences are `CodeHighlight` on a
  Shiki adapter with Selenized themes.
- `ToolCallCard` draws one 28 px row per `ToolCallView`. Its words come from a pure table. Edits draw one Mantine
  `Diff` per hunk with `withLineNumbers={false}` beside a gutter numbered from `oldStart` and `newStart`.
- `ConversationList` is Plan's virtualized, tail-following transcript, generalised. Its tests move with it.
- A markdown link opens through a new shell command, `open_web_link`, which parses the address in Rust and asks
  the builder in a native dialog before it opens.

**Tech Stack:** React 19, Mantine 9.8.0 (from M1), `@mantine/code-highlight` 9.8.0, streamdown 2.7.1,
rehype-harden, shiki 4.6.0 (`shiki/core` with the JavaScript regex engine), `@tanstack/react-virtual` 3.14.25,
Tauri 2 with `tauri-plugin-dialog` 2.8.4 and `tauri-plugin-opener` 2.7.2, Vitest, Testing Library, MSW, Playwright
(WebKit).

**Spec:** `docs/superpowers/specs/2026-11-11-10db-sessions-design.md` (v3): S10, S12, §5.2 (`ToolCallView`), §8,
§11 (Markdown, the opener), §12 (M3), §13 (pure and rendered rows), §14 (the two M3 records). With
`docs/superpowers/specs/2026-11-11-10db-sessions-ui.md`: §7.1-§7.3, §7.6, §13.1, §16. Research
`docs/architecture/research/2026-11-11-sessions-research.md` T4 §1 (streamdown: license, Tailwind, security).

## Starting point: M1, M2a, M2b and M2c have merged

- **M1:** `@mantine/core` and `@mantine/hooks` are 9.8.0, and `@mantine/code-highlight` is not yet a dependency
  (M1 plan, Task 1, call: it is added with its first import, here).
- **M2c:** `ToolCallView`, `ToolCallHunk`, `ToolCallStatus`, `ToolCallKind`, `EditChange`, `OUTPUT_TAIL_CHARS`
  and `PREVIEW_CHARS` are exported by `@10db/contracts` (`packages/contracts/src/tool-call-view.ts`). Every
  variant carries `harnessTool`, and optional fields are `nullable` (M2c calls 1 and 2). `title` is the call's
  subject; the kit adds the verb (M2c call 4). Every variant also carries `refusal: string | null` (10db's reason)
  and `deniedBy: 'builder' | '10db' | 'judge' | null` with `limit` (M2c Task 1, its calls 21 and 23), set only when
  `status` is `denied`.
- **M4b, later:** the conversation library writes full output and patches to disk
  (`<dataDir>/conversations/<id>/items/<itemId>/`) and serves them. M3 never reads them (call 7).
- **Morning check 5** (spec §16): the streamdown spike, a 20k-token message streaming at 50 ms frames in Plan's
  virtualized transcript in the Tauri webview. Add to it a turn of 300 tool rows streaming at 50 ms frames: with
  one article per turn (call 14) the whole turn re-renders on each frame, so the spike also times that. If it failed, Task 2 uses the fallback the spec names
  (react-markdown 10.1.0, rehype-sanitize 6.0.0 and `remend`, research T4 §1) behind the same `Markdown` props, and
  the PR says so. Everything else in this plan holds either way.
- **Plan today:** `views/shape/transcript.tsx:49-80` (`blocksOf`) maps messages to blocks, `:110-184` windows them
  (estimate 72 px, overscan 6, follow the tail unless scrolled up by 120 px or more, `:135`), and `:210-224` labels
  "You" and "Claude" and draws text as `pre-wrap`. `views/shape/conversation-pane.tsx:222` mounts it.
  `views/shape/transcript.test.tsx` holds the five windowing tests.

## Global Constraints

- Root `AGENTS.md`, `apps/desktop/AGENTS.md`, `packages/contracts/AGENTS.md`, `.claude/rules/code-style.md`,
  `.claude/rules/testing.md`, and `DESIGN.md`.
- Work in `../10db-worktrees/sessions-m3` on branch `feat/sessions-m3`, from `origin/main` after M2c merged. M3
  runs beside M4a; it changes no contract, and its one daemon change is the fake Plan reply Task 6's e2e row
  reads.
- **Provider parity:** the kit reads no account and no harness, and renders the same on every account kind.
- Name every path in each commit, with single-quoted `-m`. Conventional Commits, scope `desktop` (or `docs`,
  `repo`), ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Each newly tested behaviour carries
  one value card in its commit.
- Pin every new dependency exactly: `streamdown@2.7.1`, `@mantine/code-highlight@9.8.0`, `shiki@4.6.0`, and
  `rehype-harden` and `diff` at the versions Tasks 2 and 3 name.
- **Markdown never fetches.** No `<img>`, `<iframe>`, `<script>`, `<video>`, `<audio>` or `<link>` element is ever
  rendered from agent text, and no `href` that is not `https:`.
- **Selenized exactly.** Every color is a Selenized value from `apps/desktop/src/selenized.ts` or a theme token.
  Diff lines are colored text on `bg_1`, never tinted rows (UI spec §7.3, call 22).
- **`bg_1` is the builder's alone** (UI spec §7.1). Code blocks and command output sit on `bg_0` with a 1 px `bg_2`
  border; only the builder's message panel (and, inside a diff, its added and removed lines) takes `bg_1`.
- No `import 'streamdown/styles.css'`: 10db has no Tailwind, so every element streamdown draws is overridden with a
  Mantine component and its controls are off (research T4 §1).
- No label names a provider. The kit reads no harness id; Task 5 adds the lint rule that enforces it.
- **M3 renders stored items only.** No live frames, no `conversation.delta`, no streaming prop (M4b). Plan's
  composer, working line, waiting cards and announcer are unchanged (M4b moves them).
- The Workbench thread is unchanged: it still renders plain text until M4c.
- Copy is UI spec §14's, word for word.
- An agent in a 10db lane runs only the checks for what it changed. The last task runs `make gate` once.

## Calls made in this plan

Each is marked **(call)** where it is made.

1. **The kit renders `ConversationEntry`, a desktop view model** (`conversation/entry.ts`), not a contract DTO.
   M4a defines `ConversationItemDto` in parallel, so M3 cannot use it, and Plan's `ShapeMessageDto` is gone after
   M4a. Each screen maps its own DTOs to entries.
2. **Plan's tool lines become `other` calls, shaped as M4a migrates them:** the whole line in `title`,
   `harnessTool: '10db.plan'`, `name: '10db.plan'` and `inputPreview` the line cut to `PREVIEW_CHARS`. The kit's
   line rule then reads `title`, for every `other` call: the part before the first ` · ` is the name the row says
   ("Used propose_plan"), and the rest, when there is one, is its target; a title with no ` · ` is all name, and
   the target falls back to `inputPreview`. A line whose second segment is `refused` is `denied` with
   `deniedBy: '10db'`, and its third segment, when there is one, is its `refusal` (`propose_plan · refused` has
   none, `shape/tools.ts:147`). Plan's tool lines group as reads only once M4b stores typed calls.
3. **Shiki runs on `shiki/core` with `createJavaScriptRegexEngine`** and a fixed language list, each grammar
   lazy-imported. The window's CSP (`src-tauri/tauri.conf.json:30`) allows neither WebAssembly nor `eval`.
4. **The Selenized Shiki themes are built in code** from `SelenizedDark` and `SelenizedLight`, since no stock
   theme is Selenized (UI spec §7.2).
5. **rehype-harden is a direct dependency**, so the plugin list names it rather than reaching into streamdown's
   `defaultRehypePlugins`. The list is sanitize, then harden. `rehype-raw` is left out, with `skipHtml`.
6. **A link opens through `open_web_link`, a Rust command that confirms natively.** It parses the address with the
   `url` crate (`https` only, a host, no user name or password) and asks "Open {host} in your browser?" in a native
   dialog before it opens. The capability's allow list does not change. A compromised webview could otherwise
   call the opener on any `https:` URL without a confirm, which is an exfiltration path the CSP closes today. This
   follows `decisions/2026-11-09-the-opener-opens-http-on-loopback-hosts.md`. In a plain browser (Vite, e2e) a
   Mantine confirm asks instead.
7. **Full output is not fetched in M3.** `ToolCallCard` takes an optional `loadFull`. Without it, Show All Output
   and Open Full Patch don't show. M4b passes it, over `GET /conversations/:id/items/:itemId/full`.
8. **Who denied a call is the call's own `deniedBy`** (M2c). `10db` reads "10db stopped this", `builder` "You
   denied this", `judge` "Held back: this would {limit}" (or "Held back at a limit" with no `limit`; UI spec §7.3), and null (the
   agent gave no way to tell) shows no meta words, only the dimmed row, whose name ends ", denied". The
   opened row shows `refusal` in words. **Allow This** is the kit's: `ToolCallCard` and `ConversationList` take
   an optional `onAllow(call)`, and a `judge` row with `soft: true` shows Allow This when it is given (spec §5.2,
   §6.6). A hard deny never shows it. M3 has no sender, so nothing passes `onAllow` yet: M4b passes Plan's, M4c a
   pass's and M5a a chat's, each posting "Go ahead: {title}" as the builder's message.
9. **The gutter uses the `diff` package's line diff**, at the version `@mantine/code-highlight` 9.8.0 resolves. A
   rendered test checks that the gutter has one row per line `Diff` draws, of the same kind, for every row of
   Task 3's table.
10. **Diff lines are labelled through a visually hidden list.** Each hunk has a list of "added line 42: …" labels,
    and the drawn `Diff` and gutter are `aria-hidden`. Mantine's `Diff` takes no per-line label.
11. **Stored partial replies close their open syntax.** `Markdown` always runs streamdown's
    `parseIncompleteMarkdown`, so a reply cut mid-fence renders as a code block.
12. **NOTICE names streamdown.** The root `NOTICE` gains "This product includes streamdown, Copyright 2023 Vercel,
    Inc., licensed under the Apache License, Version 2.0." The license text is already `LICENSE` (10db is
    Apache-2.0 too). 10db has no third-party notice file for its MIT dependencies; that is reported as a gap, not
    built here.
13. **The reply's Copy button copies the markdown source**, not the rendered text.
14. **`ConversationList` windows by article, not by row.** UI spec §13.1 makes each message an `article` with a
    visually hidden speaker heading, and puts a turn's tool rows, notices and dividers inside the agent's article
    for that turn. A virtual item can't sit inside another element, so one virtual item is one article: a builder
    message, or the run of agent rows up to the next builder message. A very long turn mounts whole; turns are
    short next to a conversation.
15. **Plan's hidden speaker heading reads "Agent" until M4b.** No Plan DTO carries `capabilities.label` in M3, and
    no label may name a provider. M4b Task 18 must pass `agentLabel={conversation.capabilities.label}` when it moves
    Plan onto `ConversationDto`; its plan does not yet name this prop, and needs to.
16. **Consecutive edits fold** like reads (UI spec §7.3, "Folding edits"): "Edited 5 files · +40 −12", with the
    peek only under a lone edit or the last of a group.

## Review Focus

1. **A link whose text names one host and whose address another** (`[github.com](https://evil.example/x)`). The
   confirm names `evil.example`, read from the parsed address, never the link's text. Tests in Tasks 1 and 2.
2. **A stored partial reply that ends inside a fence or a list** ("```ts\nconst a ="). It renders a code block with
   what streamed and "Stopped here.", and never throws. Tests in Tasks 2 and 5.
3. **A hunk deep in a big file, or one with only additions** (`oldStart: 1200`, `oldLines: 0`). The gutter
   numbers from the hunk's own starts, not from 1. Tests in Task 3.
4. **A call whose `parentId` names a subagent that is not in the list.** It renders at the top level and is never
   dropped. Test in Task 4.
5. **A Plan tool line with no ` · `, or an empty one.** It renders as a row named by the whole line, and a
   2,000-message Plan conversation still mounts only the rows near the viewport. Tests in Tasks 5 and 6.

---

### Task 1: The opener opens confirmed `https:` links

**Files:**

- Create: `apps/desktop/src-tauri/src/web_link.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs:76-79` (register `open_web_link`), `apps/desktop/src/desktop/tauri.ts`
  (add `openWebLink` beside `openInBrowser` at `:29`), `apps/desktop/src/app.tsx` (mount `LinkConfirmHost`),
  `tests/repo/src/desktop-opener.test.ts`
- Create: `apps/desktop/src/desktop/open-web-link.test.tsx`, `apps/desktop/src/conversation/link-confirm.tsx`
- Create: `docs/architecture/decisions/./2026-11-12-the-opener-opens-confirmed-https-links.md` (use the commit's own
  date if it lands later)

**Interfaces:**

- Produces:
  - Rust: `fn web_link(url: &str) -> Result<url::Url, String>` (pure) and
    `#[tauri::command] async fn open_web_link(app: tauri::AppHandle, url: String) -> Result<bool, String>`, which
    returns `true` when the builder chose Open and the page opened, `false` on Cancel.
  - TypeScript, `src/desktop/tauri.ts`: `openWebLink(url: string): Promise<void>`. In Tauri it invokes
    `open_web_link`. In a plain browser it asks through `confirmWebLink(host)` (`conversation/link-confirm.tsx`, a
    Mantine `modals`-free `Modal` driven by a module store, "Open {host} in your browser?" with Open and Cancel),
    then `window.open(url, '_blank')` with `opener = null`. A URL `URL.parse` rejects, or one not `https:`, rejects
    with `WebLinkRefusedError` (`name = 'WebLinkRefusedError'`) before anything asks.
  - `LinkConfirmHost`: the component that draws the browser confirm, mounted once in `app.tsx` beside the
    providers.

- [ ] **Step 1: Write the failing Rust table** in `web_link.rs` (`#[cfg(test)]`), one row per case:

| input | result |
| --- | --- |
| `https://ok.example/a?b=1#c` | Ok, host `ok.example` |
| `HTTPS://OK.EXAMPLE/` | Ok, host `ok.example` |
| `http://ok.example/` | Err |
| `javascript:alert(1)` | Err |
| `file:///etc/passwd` | Err |
| `https://user:pw@ok.example/` | Err |
| `https://github.com@evil.example/` | Err (a user name) |
| `https:///nohost` | Err |
| `not a url` | Err |
| `https://аррӏе.com/` (Cyrillic, an IDN) | Ok, host `xn--80ak6aa92e.com`: the confirm's title names the punycode host |

- [ ] **Step 2: Run it and watch it fail**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml web_link`
Expected: FAIL to compile, because `web_link` does not exist.

- [ ] **Step 3: Implement `web_link` and `open_web_link`.** The command parses with `web_link`, then shows a
  native message dialog through `tauri_plugin_dialog::DialogExt` titled "Open {host} in your browser?" (the parsed
  host, punycode for an IDN), with the full address as its message and the buttons Open and Cancel
  (`MessageDialogButtons::OkCancelCustom`). The command is async, so it calls `show` with a callback that sends the
  answer down a `tokio::sync::oneshot` channel and awaits it; never `blocking_show`, which would block the async
  runtime. On Open it calls the opener plugin's Rust API
  (`app.opener().open_url`), as `open_app_page` does (`lib.rs:47`). Register it in `generate_handler!`.

- [ ] **Step 4: Run it**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml web_link && cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 5: Write the failing TypeScript tests** in `open-web-link.test.tsx`:
  - **In Tauri** (`mockIPC` from `@tauri-apps/api/mocks`, as the folder tests do): `openWebLink('https://ok.example/a')`
    invokes `open_web_link` with `{ url: 'https://ok.example/a' }`, and never `plugin:opener|open_url`.
  - **In a browser:** it shows "Open ok.example in your browser?"; Cancel opens nothing; Open calls `window.open`
    once with the URL (spy on `window.open`).
  - **Refused before asking:** `http://ok.example/` and `javascript:alert(1)` reject with `WebLinkRefusedError` and
    show no confirm.
- Extend `tests/repo/src/desktop-opener.test.ts:33-41`'s second test to also match `open_web_link` in
  `generate_handler!`. Its first test, the allow list, stays exactly as it is: the list does not widen (call 6).

- [ ] **Step 6: Run them, watch them fail, implement `openWebLink` and `LinkConfirmHost`, and run them again**

Run: `pnpm --filter @10db/desktop exec vitest run src/desktop/open-web-link.test.tsx && pnpm --filter @10db/repo-checks exec vitest run src/desktop-opener.test.ts`
Expected: FAIL first (no `openWebLink`), then PASS.

- [ ] **Step 7: Write the decision record**, `2026-11-12-the-opener-opens-confirmed-https-links.md`, with
  **Amends:** `decisions/2026-11-08-the-desktop-opener-opens-artificial-analysis.md`. Decision: links in agent
  markdown open any `https:` address the builder confirms, through `open_web_link`; the capability's allow list is
  unchanged; the confirm is native and names the parsed host. Why: call 6's reasons, and the alternatives turned
  down (a scope of `https://*`, which opens without a confirm from any script in the webview; a JavaScript confirm
  in Tauri, which a compromised page skips).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src-tauri/src/web_link.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/desktop/tauri.ts apps/desktop/src/desktop/open-web-link.test.tsx apps/desktop/src/conversation/link-confirm.tsx apps/desktop/src/app.tsx tests/repo/src/desktop-opener.test.ts docs/architecture/decisions/./2026-11-12-the-opener-opens-confirmed-https-links.md && git commit -m 'feat(desktop): a link in agent text opens any https address after a native confirm

Value: protects=an agent link opens only https, only after the builder confirms the parsed host; fails_when=http, javascript or a user-name address opens, the confirm names the link text, or the allow list widens; why_new=the opener only had fixed hosts; no_claim=that the native dialog looks right (checked by hand in dev:shell)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 2: `Markdown`, hardened, with the hostile-markdown test

**Files:**

- Modify: `apps/desktop/package.json`, `pnpm-lock.yaml`, `NOTICE` (call 12)
- Create: `apps/desktop/src/conversation/markdown.tsx`, `apps/desktop/src/conversation/rehype-agent-safety.ts`,
  `apps/desktop/src/conversation/markdown-elements.tsx`,
  `apps/desktop/src/conversation/markdown.module.css`, `apps/desktop/src/conversation/markdown.test.tsx`,
  `apps/desktop/src/conversation/index.ts`

**Interfaces:**

- Produces, from `apps/desktop/src/conversation/index.ts`:
  - `Markdown({ text }: { readonly text: string }): JSX.Element`
- Consumes: `openWebLink(url: string): Promise<void>` from Task 1, for links.

- [ ] **Step 1: Add the dependencies and read the sources.** `pnpm --filter @10db/desktop add --save-exact
  streamdown@2.7.1`, then `npm view rehype-harden version` and add that exactly. Check `pnpm why rehype-harden
  --filter @10db/desktop` shows one version (streamdown's range `^1.1.8` must resolve to the pinned one). Then read
  `node_modules/streamdown/dist/index.d.ts` and its chunk:
  - `defaultRehypePlugins.sanitize` and `defaultRemarkPlugins.gfm` are exported (2.7.1 has them as
    `{ raw, sanitize, harden }` and `{ gfm, codeMeta }`). If `sanitize` is missing, add `rehype-sanitize` exactly
    and use it with GitHub's schema.
  - Whether rehype-harden replaces a blocked image or link with its own element (a "blocked" span) before
    `components` run. 2.7.1's harden does, so 10db's own step (`rehype-agent-safety.ts`, below) runs before harden
    and decides what the builder reads; harden stays as the second wall.

- [ ] **Step 2: Write the failing hostile-markdown table** in `markdown.test.tsx`, rendered with
  `renderWithTheme` (`src/test/theme.tsx:25`). One named row per input. Every row also asserts that the container
  holds no `img`, `iframe`, `script`, `video`, `audio`, `link` or `object` element, no element with a `src`
  attribute, and no `href` that doesn't start with `https://`.

| row | input | also asserts |
| --- | --- | --- |
| image beacon | `![x](https://evil.example/b.png)` | text "Image not shown: x" |
| reference image | `![x][r]\n\n[r]: https://evil.example/b.png` | text "Image not shown: x" |
| raw img | `<img src="https://evil.example/b.png">` | — |
| data image | `![d](data:image/png;base64,iVBORw0KGgo=)` | text "Image not shown: d" |
| javascript link | `[click](javascript:alert(1))` | the text "click" shows; no link |
| http link | `[plain](http://plain.example/)` | the text shows; no link |
| script | `<script>alert(1)</script>` | no text "alert(1)" |
| iframe | `<iframe src="https://evil.example"></iframe>` | — |
| raw anchor | `<a href="https://evil.example">raw</a>` | no link |
| https link | `[docs](https://ok.example/a)` | one link named "docs" |
| autolink | `see https://ok.example/b` | one link to `https://ok.example/b` |
| dollars | `costs $5 and $6, or $$x$$` | the text shows with its dollars; no `math` or `.katex` element |
| mermaid fence | a ```mermaid fence | a code block with its text; no `svg` |

- [ ] **Step 3: Write the failing element rows** in the same file:
  - `# Title` renders a heading (level 1) and `### Small` a level 3; `- a\n- b` a list of two items; `` `x` `` a
    `code` element; a GFM table a `table` with its header cells; `> q` a blockquote.
  - **A partial fence** (call 11): `"Here:\n```ts\nconst a ="` renders the text `const a =` inside the code block
    code block (a `code` element inside `pre` now; Task 3's `CodeBlock` re-runs this row), and no backticks show as
    text.
  - **A link click, in Tauri** (`mockIPC`, as the folder tests do): it invokes `open_web_link` with
    `{ url: 'https://ok.example/a' }`, and never `plugin:opener|open_url`.
  - **A link click, in a browser:** the confirm "Open ok.example in your browser?" shows, and `window.open` (a spy)
    has not been called before Open is pressed. No mock of 10db's own modules.

- [ ] **Step 4: Run them and watch them fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/conversation/markdown.test.tsx`
Expected: FAIL, because `./markdown` does not exist.

- [ ] **Step 5: Implement `Markdown`** in `markdown.tsx`: `<Streamdown mode="static" parseIncompleteMarkdown
  skipHtml controls={false} linkSafety={{ enabled: false }} remarkPlugins={MARKDOWN_REMARK_PLUGINS}
  rehypePlugins={MARKDOWN_REHYPE_PLUGINS} components={MARKDOWN_ELEMENTS}>`.
  - `MARKDOWN_REMARK_PLUGINS` is GFM only (`[defaultRemarkPlugins.gfm, defaultRemarkPlugins.codeMeta]`), and no
    `plugins` prop is passed, so `$x$` is never math, a fence is never Mermaid, and streamdown's own Shiki, Mermaid
    and KaTeX chunks never load (Task 6's e2e row watches for them).
  - `MARKDOWN_REHYPE_PLUGINS` is `[defaultRehypePlugins.sanitize, rehypeAgentSafety, [harden, {
    allowedImagePrefixes: [], allowedLinkPrefixes: ['https://'], allowedProtocols: ['https'], allowDataImages: false
    }]]` (call 5), with `harden` imported from `rehype-harden`.
  - `rehypeAgentSafety` (`conversation/rehype-agent-safety.ts`, 10db's own step): every `img` becomes a
    `span` reading "Image not shown: {alt}", and every `a` whose `href` is not `https:` is replaced by its children,
    so the text stays and no link does.
  - `markdown-elements.tsx` holds `MARKDOWN_ELEMENTS`, one Mantine element per tag, styled by UI spec §7.2:
    - `p`: `Text size="sm"` with line height 1.6; `h1`-`h6`: `Title` at 17, 15, then 14 px, weight 600, `c="bright"`
    - `ul`, `ol`, `li`: `List size="sm"`, 4 px between items; `inlineCode`: `Code`
    - `pre`/`code` (a fence): Task 3's `CodeBlock` with the fence's language
    - `a`: `Anchor` (blue) whose click prevents default and calls `openWebLink(href)`
    - `table` and its parts: `Table` sm, hairline `bg_2` rules, no stripes
    - `blockquote`: `dim_0` text with a 2 px `bg_2` rule at its left (`markdown.module.css`)
    - `img`: a dimmed `Text size="xs"` "Image not shown: {alt}". It never renders an `<img>`.
  - Until Task 3, `pre` renders a plain `Code block`; Task 3 swaps it for `CodeBlock` and re-runs these rows.

- [ ] **Step 6: Run them**

Run: `pnpm --filter @10db/desktop exec vitest run src/conversation/markdown.test.tsx`
Expected: PASS.

- [ ] **Step 7: Add the NOTICE line** (call 12), then commit.

```bash
git add apps/desktop/package.json pnpm-lock.yaml NOTICE apps/desktop/src/conversation/index.ts apps/desktop/src/conversation/rehype-agent-safety.ts apps/desktop/src/conversation/markdown.tsx apps/desktop/src/conversation/markdown-elements.tsx apps/desktop/src/conversation/markdown.module.css apps/desktop/src/conversation/markdown.test.tsx && git commit -m 'feat(desktop): agent text renders as hardened markdown that never fetches

Value: protects=agent markdown can neither load a resource nor run a script, and links are https only; fails_when=an image, iframe, script or data URL renders, a non-https href survives, or the harden list widens; why_new=nothing rendered markup before; no_claim=that the opener confirms (open-web-link tests) or that fences highlight (code-block tests)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 3: Code fences and per-hunk diffs

**Files:**

- Modify: `apps/desktop/package.json`, `pnpm-lock.yaml`, `apps/desktop/src/app.tsx` (mount the adapter provider),
  `apps/desktop/src/test/theme.tsx` and `apps/desktop/src/test/daemon.tsx` (the same provider in the render
  helpers), `apps/desktop/src/conversation/markdown-elements.tsx` (fences use `CodeBlock`)
- Create: `apps/desktop/src/conversation/shiki.ts`, `apps/desktop/src/conversation/selenized-shiki.ts`,
  `apps/desktop/src/conversation/selenized-shiki.test.ts`, `apps/desktop/src/conversation/code-block.tsx`,
  `apps/desktop/src/conversation/code-block.test.tsx`, `apps/desktop/src/conversation/hunk-gutter.ts`,
  `apps/desktop/src/conversation/hunk-gutter.test.ts`, `apps/desktop/src/conversation/hunk-diff.tsx`,
  `apps/desktop/src/conversation/hunk-diff.module.css`, `apps/desktop/src/conversation/hunk-diff.test.tsx`

**Interfaces:**

- Produces:
  - `SHIKI_LANGUAGES`: a map from a fence's language to a lazy import of its grammar module, by the module names
    `@shikijs/langs` exports (call 3): `typescript`, `tsx`, `javascript`, `jsx`, `json`, `shellscript`, `css`,
    `html`, `markdown`, `yaml`, `toml`, `sql`, `rust`, `python`, `go`, `diff`. Aliases map to those modules: `ts` →
    `typescript`, `js` → `javascript`, `sh`, `bash`, `shell` and `zsh` → `shellscript`, `md` → `markdown`, `yml` →
    `yaml`, `py` → `python`, `rs` → `rust`. Anything else resolves to `undefined`, which renders plain text.
  - `shikiAdapter`: `createShikiAdapter(loadShiki, { resolveLanguage })` from `@mantine/code-highlight`, where
    `loadShiki` uses `createHighlighterCore` from `shiki/core` and `createJavaScriptRegexEngine()` from
    `shiki/engine/javascript` (call 3), and loads the two themes below.
  - `selenizedShikiTheme(variant: SelenizedVariant, type: 'light' | 'dark'): ThemeRegistration` and
    `SELENIZED_SHIKI_THEMES: readonly [ThemeRegistration, ThemeRegistration]` (call 4)
  - `CodeBlock({ code, language }: { readonly code: string; readonly language: string | null })`: Mantine
    `CodeHighlight` on `bg_0` with a 1 px `bg_2` border, with the language label and its Copy control, `maxHeight`
    none, overflowing sideways.
  - `GutterLine = { readonly kind: 'context' | 'added' | 'removed'; readonly number: number; readonly text: string }`
  - `hunkGutter(hunk: ToolCallHunk): readonly GutterLine[]`: context and added lines numbered from `newStart`,
    removed lines from `oldStart`, in the order `diffLines(hunk.before, hunk.after)` yields them (call 9).
  - `HunkDiff({ hunk, first, maxLines }: { readonly hunk: ToolCallHunk; readonly first: boolean; readonly maxLines?: number })`:
    a dimmed `@@ −{oldStart},{oldLines} +{newStart},{newLines} @@` line when not `first`, then the gutter beside a
    Mantine `Diff` (`previousValue={hunk.before}`, `currentValue={hunk.after}`, `withLineNumbers={false}`,
    `diffMethod="lines"`, `contextLines={Infinity}`, unified), cut to `maxLines` rows when given. Colors through
    `Diff`'s CSS variables in `hunk-diff.module.css`: added green text on `bg_1` with a green "+", removed red on
    `bg_1` with a red "−", context `fg_0` on `bg_0`, a changed word on `bg_2`. The visually hidden label list of
    call 10 ("added line 42: …", "removed line 40: …", "line 41: …").

- [ ] **Step 1: Add the dependencies.** `@mantine/code-highlight@9.8.0`, `shiki@4.6.0` and `@shikijs/langs` at the
  version `shiki@4.6.0` depends on (`npm view shiki@4.6.0 dependencies`), each exact: pnpm is strict, so the grammar
  modules must be a direct dependency. Then `pnpm why diff --filter @10db/desktop` names the `diff` version
  `@mantine/code-highlight` resolves; add `diff` exactly at that version (call 9). If it is older than
  `npm view diff version`, write the held-back pin's decision record
  (`docs/architecture/decisions/./2026-11-12-the-desktop-pins-diff-to-mantines.md`: the gutter must diff as `Diff` does).

- [ ] **Step 2: Read the adapter.** Read `node_modules/@mantine/code-highlight`'s Shiki adapter source (or
  `get_item_doc code-highlight-getting-started full` on the Mantine MCP server). Confirm `createShikiAdapter(load,
  { resolveLanguage })` is its signature in 9.8.0, and find the theme names it asks Shiki for in light and dark. `selenized-shiki.ts` names its two themes with exactly those names, so the adapter picks
  them with no other change. Write the names you found into a one-line comment in `shiki.ts`.

- [ ] **Step 3: Write the failing pure tests.**
  - `selenized-shiki.test.ts`: for each of the two themes, every color in `colors` and every
    `tokenColors[].settings.foreground` and `background` is a value of that Selenized variant (collect the values
    from `SelenizedDark`/`SelenizedLight`); the background is `bg0` and the foreground `fg0`; comments are `dim0`.
  - `hunk-gutter.test.ts`, one named row each:

| row | hunk | gutter |
| --- | --- | --- |
| one line changed | `oldStart 41, newStart 41`, 3 context, `-a`, `+b`, 3 context | 41, 42, 43 context; 44 removed; 44 added; 45, 46, 47 context |
| deep in a file | `oldStart 1200, newStart 1203`, one added line after 3 context | 1203-1205 context, 1206 added |
| a new file | `oldStart 0, oldLines 0, newStart 1`, 3 lines | 1, 2, 3 added |
| a deleted file | `newStart 0, newLines 0, oldStart 1`, 2 lines | 1, 2 removed |
| two changes in one hunk | `-a +b`, context, `-c +d` | removed and added numbered apart, each side from its own start |

- [ ] **Step 4: Write the failing rendered tests.**
  - `code-block.test.tsx`: a `ts` fence shows "ts" and a button named "Copy"; `sh` and `md` fences resolve to their
    modules (`shellscript`, `markdown`); clicking it writes the code to the
    clipboard (`navigator.clipboard.writeText` spy); an unknown language (`klingon`) renders the code as plain text
    with no error; `null` language shows no label.
  - `hunk-diff.test.tsx`: for every row of the gutter table, the gutter has as many rows as `Diff` draws lines,
    row by row of the same kind (read `Diff`'s line rows and their added/removed markers from the DOM; the
    implementer names the selectors after reading Step 2's source) (call 9); the hunk header shows only when
    `first` is false; `maxLines={8}` on a 20-line hunk draws 8 rows; the hidden list reads "added line 44: b".

- [ ] **Step 5: Run them and watch them fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/conversation/selenized-shiki.test.ts src/conversation/hunk-gutter.test.ts src/conversation/code-block.test.tsx src/conversation/hunk-diff.test.tsx`
Expected: FAIL, because the modules do not exist.

- [ ] **Step 6: Implement** the modules above, mount `CodeHighlightAdapterProvider adapter={shikiAdapter}` inside
  `MantineProvider` in `app.tsx` and in the test render helpers, and import `@mantine/code-highlight/styles.css`
  after `@mantine/core/styles.css` (`app.tsx:1`). Switch `markdown-elements.tsx`'s fence to `CodeBlock`.

- [ ] **Step 7: Run them, and Task 2's file**

Run: `pnpm --filter @10db/desktop exec vitest run src/conversation`
Expected: PASS.

- [ ] **Step 8: Check highlighting under the real CSP.** Vite sends only `img-src` (`apps/desktop/AGENTS.md:18-21`),
  so `pnpm dev` can't catch WebAssembly or `eval`. Click through a Plan reply with a `ts` fence in `dev:shell`, the
  Tauri window with the real CSP (`tauri.conf.json:30`), in light and dark: Selenized colors, and no CSP error in
  the web inspector's console. Task 6's e2e row checks the same in WebKit on every run.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/app.tsx apps/desktop/src/test/theme.tsx apps/desktop/src/test/daemon.tsx apps/desktop/src/conversation/markdown-elements.tsx apps/desktop/src/conversation/shiki.ts apps/desktop/src/conversation/selenized-shiki.ts apps/desktop/src/conversation/selenized-shiki.test.ts apps/desktop/src/conversation/code-block.tsx apps/desktop/src/conversation/code-block.test.tsx apps/desktop/src/conversation/hunk-gutter.ts apps/desktop/src/conversation/hunk-gutter.test.ts apps/desktop/src/conversation/hunk-diff.tsx apps/desktop/src/conversation/hunk-diff.module.css apps/desktop/src/conversation/hunk-diff.test.tsx && git commit -m 'feat(desktop): code fences highlight in Selenized, and each edit hunk draws as a Diff with its real line numbers

Value: protects=a hunk shows the file line numbers it came from, aligned with the lines Diff draws, in Selenized colors; fails_when=the gutter numbers from 1, drifts from the drawn rows, or a theme color is not a Selenized value; why_new=no diff or highlighting existed in the UI; no_claim=that edits get the right hunks (the daemon hunks tests)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 4: `ToolCallCard`: one row per kind, groups and nesting

**Files:**

- Create: `apps/desktop/src/conversation/entry.ts`, `apps/desktop/src/conversation/tool-words.ts`,
  `apps/desktop/src/conversation/tool-words.test.ts`, `apps/desktop/src/conversation/conversation-rows.ts`,
  `apps/desktop/src/conversation/conversation-rows.test.ts`, `apps/desktop/src/conversation/tool-row.tsx`,
  `apps/desktop/src/conversation/tool-call-card.tsx`, `apps/desktop/src/conversation/tool-bodies.tsx`,
  `apps/desktop/src/conversation/tool-call-card.test.tsx`
- Modify: `apps/desktop/src/conversation/index.ts`

**Interfaces:**

- Produces, exported from `index.ts`:
  - `ConversationEntry` (call 1), a union on `kind`, each with `id: string`:
    - `{ kind: 'builder'; text: string; extra: ReactNode | null }` (`extra`: pictures or mention chips a screen draws)
    - `{ kind: 'reply'; text: string; partial: boolean }`
    - `{ kind: 'reasoning'; text: string; durationMs: number | null }`
    - `{ kind: 'tool'; call: ToolCallView }` (who denied it is `call.deniedBy`, call 8)
    - `{ kind: 'notice'; text: string; tone: 'info' | 'error' }`
    - `{ kind: 'divider'; text: string; action: { label: string; onClick: () => void } | null }`
    - `{ kind: 'custom'; render: () => ReactNode }` (a screen's own row, such as Plan's screenshot)
  - `ToolEntry = Extract<ConversationEntry, { kind: 'tool' }>`
  - `ConversationRow`, a union: `{ kind: 'entry'; entry: ConversationEntry }`,
    `{ kind: 'tool'; entry: ToolEntry; nested: readonly ToolEntry[] }`,
    `{ kind: 'tool_group'; id: string; entries: readonly ToolEntry[] }` (reads and searches) and
    `{ kind: 'edit_group'; id: string; entries: readonly ToolEntry[] }` (call 16)
  - `conversationRows(entries: readonly ConversationEntry[]): readonly ConversationRow[]`:
    - Consecutive top-level `read` and `search` calls fold into one `tool_group` (id: its first entry's id). Any
      other entry ends the group. A group of one is a plain `tool` row.
    - Consecutive top-level `edit` calls fold into one `edit_group` the same way; reply text, a read or a command
      ends it (call 16).
    - An entry whose `call.parentId` names a `subagent` entry in the list goes into that row's `nested`, in order.
      An orphan stays at the top level (Review Focus 4).
  - `ToolRowWords = { icon: ToolIcon; verb: string; target: string | null; meta: string | null; tone: 'dimmed' | 'red'; name: string }`,
    `ToolIcon` an `as const` object of Tabler names (`terminal`, `pencil`, `file`, `search`, `plug`, `hierarchy`,
    `world`, `tool`, `brain`)
  - `toolRowWords(call: ToolCallView): ToolRowWords`, reading `call.deniedBy` and `call.refusal`
  - `groupWords(entries: readonly ToolEntry[]): { text: string; name: string }`
  - `editGroupWords(entries: readonly ToolEntry[]): { text: string; name: string }`: "Edited 5 files · +40 −12"
  - `formatDuration(ms: number | null): string | null`: "9 s" under a minute, "1 min", "12 min", null for null
  - `ToolCallCard({ entry, nested, loadFull, onAllow }: { readonly entry: ToolEntry; readonly nested: readonly ToolEntry[]; readonly loadFull?: (callId: string) => Promise<string>; readonly onAllow?: (call: ToolCallView) => void })`
    (call 7), `ToolGroupRow({ entries })` and `EditGroupRow({ entries, loadFull })`: opened, it lists each file with
    its counts; the last edit's peek always shows under it

- [ ] **Step 1: Write the failing `tool-words.test.ts` table**, one named row per kind and status. The words are UI
  spec §7.3 and §14's:

| row | call | verb · target · meta · tone | name |
| --- | --- | --- | --- |
| command done | `pnpm vitest run src/api`, 9,000 ms, exit 0 | "Ran" · `pnpm vitest run src/api` · "9 s" · dimmed | "Ran pnpm vitest run src/api, 9 seconds" |
| command failed | the same, exit 1, failed | … · "exit 1 · 9 s" · red | "Ran pnpm vitest run src/api, failed, exit 1, 9 seconds" |
| command running | no duration | … · null | "Running pnpm …" |
| edit update | `src/api/client.ts`, +4 −2 | "Edited" · path · "+4 −2" | … |
| edit add / delete / move | | "Created" / "Deleted" / "Moved" · `a` · "to b" | … |
| read | `src/router.tsx` | "Read" · path | |
| search | pattern `retry` | "Searched for" · `retry` | |
| mcp | `github · get_pr`, preview | "github · get_pr" · preview | |
| mcp failed | `error` set | … · red | |
| subagent | preview, 3 nested, 60,000 ms | "Subagent:" · preview · "3 calls · 1 min" (+ model when set) | |
| web query / url | | "Searched the web for ‘q’" / "Fetched ok.example" | |
| other | title `propose_plan`, preview `x` | "Used propose_plan" · `x` | "Used propose_plan: x" |
| other, a Plan line | title `propose_plan · 1 goal, 3 loose · passed`, harnessTool `10db.plan` | "Used propose_plan" · `1 goal, 3 loose · passed` | "Used propose_plan: 1 goal, 3 loose · passed" |
| denied by 10db | `deniedBy: '10db'`, no refusal | meta "10db stopped this", dimmed | |
| denied with a refusal | `deniedBy: '10db'`, `refusal: 'writes outside the checkout'` | meta "10db stopped this"; the name ends ", writes outside the checkout" | |
| denied by builder | `deniedBy: 'builder'` | meta "You denied this", dimmed | |
| denied by the judge | `deniedBy: 'judge'`, `limit` set, `soft: true`, `onAllow` given | meta "Held back: this would {limit}", dimmed, and an Allow This button that calls `onAllow` once | |
| a hard deny by the judge | `deniedBy: 'judge'`, `soft: false`, `onAllow` given | meta "Held back at a limit", dimmed, no Allow This | |
| denied, unknown | `deniedBy: null` | no meta, dimmed | the name ends ", denied" |

  And `groupWords`, one row each: 5 reads and 2 searches read "Read 5 files, searched 2 times"; 1 read and 1 search
  read "Read 1 file, searched 1 time"; 3 reads alone read "Read 3 files"; 2 searches alone read "Searched 2 times"
  (a count of zero is left out, as the spec's words are); a group whose last read is `running` reads "Reading `src/router.tsx`". `editGroupWords`
  over three edits of +10 −2, +20 −0 and +10 −10 reads "Edited 3 files · +40 −12".

- [ ] **Step 2: Write the failing `conversation-rows.test.ts` table**: three reads then a reply then one read (a
  group of 3, the reply, a plain row); read, edit, read (no group); three edits then a command (an edit group of 3,
  then the command); edit, read, edit (no group); a subagent with two children and an orphan
  whose parent is absent (the orphan stays top level, Review Focus 4); children of a subagent that sit between
  reads don't break the group of their siblings at the top level.

- [ ] **Step 3: Write the failing `tool-call-card.test.tsx`**, rendered:
  - A row is a button with `aria-expanded="false"` and the full name from Step 1; Enter opens it.
  - **Command:** opened, it shows `outputTail` in mono on `bg_0` with a `bg_2` border; with `outputBytes` 212 KB it also says "Showing the last
    4 KB of 212 KB", and "Show All Output" shows only when `loadFull` is given. **A failed command opens by
    itself** to its last 8 lines (UI spec call 21).
  - **Edit:** collapsed, a lone edit still shows the peek, the first hunk at most 8 lines (UI spec call 21), through
    `HunkDiff`; an `EditGroupRow` of three shows one peek, under its last edit, and opened lists the three files with
    their counts; "Show Full Diff" draws every hunk; `truncated` says "Cut at 1,500 changed lines", with "Open Full
    Patch" only with `loadFull`.
  - **Running:** the icon's place holds an 8 px blue dot (`data-status="running"`).
  - **Denied with a refusal:** the row reads "10db stopped this", and opened it shows the refusal in words.
  - **Subagent:** its nested rows render under it, indented, when opened.
  - **Group:** a `ToolGroupRow` of three reads names the group, and opened lists one call per line.

- [ ] **Step 4: Run them and watch them fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/conversation/tool-words.test.ts src/conversation/conversation-rows.test.ts src/conversation/tool-call-card.test.tsx`
Expected: FAIL, because the modules do not exist.

- [ ] **Step 5: Implement.** `tool-call-card.tsx` switches over `call.kind` exhaustively to the bodies in
  `tool-bodies.tsx`. `tool-row.tsx` is the 28 px row: icon 16, verb, target in mono, meta dimmed (or red), and a
  chevron. Tabler icons at stroke 1.5. A nested row is 16 px in, with a hairline `bg_2` rule at its left.

- [ ] **Step 6: Run them**

Run: `pnpm --filter @10db/desktop exec vitest run src/conversation`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/conversation/index.ts apps/desktop/src/conversation/entry.ts apps/desktop/src/conversation/tool-words.ts apps/desktop/src/conversation/tool-words.test.ts apps/desktop/src/conversation/conversation-rows.ts apps/desktop/src/conversation/conversation-rows.test.ts apps/desktop/src/conversation/tool-row.tsx apps/desktop/src/conversation/tool-call-card.tsx apps/desktop/src/conversation/tool-bodies.tsx apps/desktop/src/conversation/tool-call-card.test.tsx && git commit -m 'feat(desktop): tool calls draw as one-line rows per kind, with reads folded and subagent calls nested

Value: protects=each tool kind and status reads in its own words, reads fold, subagent calls nest, and a failed command opens itself; fails_when=a kind or status loses its words, a group spans an edit, or an orphan call is dropped; why_new=tool activity was one plain string; no_claim=that adapters map tools to the right kind (M2c mapping tables)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 5: `ConversationList`, generalised from Plan's transcript

**Files:**

- Create: `apps/desktop/src/conversation/conversation-list.tsx`,
  `apps/desktop/src/conversation/conversation-list.test.tsx`, `apps/desktop/src/conversation/entry-view.tsx`
- Modify: `apps/desktop/src/conversation/index.ts`, `eslint.config.js` (the harness-id rule)

**Interfaces:**

- Consumes: `ConversationEntry`, `conversationRows`, `ToolCallCard`, `ToolGroupRow`, `EditGroupRow` (Task 4),
  `Markdown` (Task 2).
- Produces:
  - `ConversationListProps`:
    - `entries: readonly ConversationEntry[]`
    - `highlight: { readonly ids: readonly string[]; readonly nonce: number } | null`: marks those rows and scrolls
      the first to the centre on each new `nonce` (Plan's Why?)
    - `loadFull?: (callId: string) => Promise<string>`
    - `onAllow?: (call: ToolCallView) => void` (call 8)
    - `agentLabel: string`: the agent's hidden speaker heading, `capabilities.label` (call 15)
  - `conversationArticles(rows: readonly ConversationRow[]): readonly ConversationArticle[]`, pure:
    `ConversationArticle = { id: string; speaker: 'builder' | 'agent'; rows: readonly ConversationRow[] }`. A
    builder entry is an article of its own; every other row joins the agent article that follows the last builder
    message (call 14).
  - `ConversationList(props: ConversationListProps)`: the windowed column, one virtual item per article (estimate
    72, overscan 6, Plan's values), a `ScrollArea` whose viewport is `role="group"` named "Messages",
    `tabIndex={0}`. Each article is an `<article>` whose first child is a visually hidden heading, "You" or
    `agentLabel`. Each row carries `data-message-id`, the attribute Plan's rows carry today and
    `e2e/shape.spec.ts:225-260` counts, so that spec needs no change.
  - **Highlight and Why?** scroll to the article holding the first highlighted id, then bring the row into view
    inside it.
  - `ConversationEntryView({ entry })` in `entry-view.tsx`:
    - `builder`: a `bg_1` panel, radius `md`, padding 10 × 12, `c="bright"` text in `pre-wrap`, then `extra`; 20 px
      above it
    - `reply`: `Markdown`, with a Copy icon button at its top right on hover and focus (call 13); a `partial` reply
      ends with one dimmed line, "Stopped here."
    - `reasoning`: a collapsed row, `brain` icon, "Thought for 12 s" (or "Thought" when `durationMs` is null),
      opening to the text in `dim_0` with a 2 px `bg_2` rule (UI spec §7.6)
    - `notice`: Plan's info line (dimmed, `IconInfoCircle`); `error` tone red
    - `divider`: a rule across the column with the text and the optional action
    - `custom`: `render()`
  - No speaker labels (UI spec call 19).
- **Behaviour kept from `views/shape/transcript.tsx`:** follow the tail unless scrolled up by 120 px or more;
  the hand-written `useCallback` for `getItemKey` and its comment (`:112-115`); Why? scrolling to centre.
- **Added:** while the builder is scrolled up by 120 px or more, a **Jump to Latest** button (`arrow-down` icon)
  floats at the foot of the list and scrolls to the end. Rows are spaced per UI spec §7.1: 2 px between
  consecutive tool rows, 8 px around a group of them, 12 px between replies.
- **The lint rule:** in `eslint.config.js`, for `apps/desktop/src/conversation/**`, `no-restricted-syntax` with
  three selectors, each with the message "The kit reads capabilities, never a harness (sessions UI spec §11).":
  - `BinaryExpression[operator=/^[!=]==?$/] > Literal[value=/^(claude|codex)$/]`
  - `SwitchCase > Literal.test[value=/^(claude|codex)$/]` (`case 'claude':`)
  - `CallExpression[callee.property.name='includes'] > Literal[value=/^(claude|codex)$/]` (`.includes('codex')`)

  M5a extends it to `views/sessions/**`.

- [ ] **Step 0: Write the failing `conversationArticles` table** in `conversation-rows.test.ts`: builder, reply,
  tool, builder gives three articles (the reply and the tool share the second); a conversation that opens with
  agent rows starts with an agent article; two builder messages in a row are two articles.

- [ ] **Step 1: Move the five windowing tests.** Copy `views/shape/transcript.test.tsx`'s setup (`:9-56`) and its
  five tests into `conversation-list.test.tsx`, building entries instead of messages (`{ kind: i % 2 ? 'reply' :
  'builder', id, text: \`Message ${i}\` }`), and querying rows by `[data-message-id]`. The assertions stay as they
  are. Then add:
  - **Jump to Latest:** scrolled up by 500 rows, the button shows; clicking it scrolls to the end, and the button
    goes; at the tail it is absent.
  - **The articles:** a builder entry renders on a panel with no visible "You", inside an `article` labelled by its
    hidden heading "You"; a reply sits in an article headed by `agentLabel`.
  - **The rows:** a builder entry renders on a panel; a reply renders its markdown heading; a
    partial reply ends "Stopped here."; three reads render one row named "Read 3 files"; a `custom` entry renders what it returns.
  - **Copy:** the reply's Copy writes its markdown source (`navigator.clipboard.writeText` spy).

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/conversation/conversation-list.test.tsx`
Expected: FAIL, because `./conversation-list` does not exist.

- [ ] **Step 3: Implement `ConversationList` and `ConversationEntryView`**, windowing `conversationRows(entries)`.
  Add the lint rule.

- [ ] **Step 4: Prove the lint rule goes red.** Add, one at a time, `if (label === 'claude') {}`, `switch (h) {
  case 'codex': }` and `harnesses.includes('codex')` to a scratch line in `conversation-list.tsx`, run `pnpm
  --filter @10db/desktop exec eslint src/conversation`, see the rule's message each time, and remove the line.

- [ ] **Step 5: Run the tests and lint**

Run: `pnpm --filter @10db/desktop exec vitest run src/conversation && pnpm --filter @10db/desktop exec eslint src/conversation`
Expected: PASS, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/conversation/index.ts apps/desktop/src/conversation/conversation-list.tsx apps/desktop/src/conversation/conversation-list.test.tsx apps/desktop/src/conversation/entry-view.tsx eslint.config.js && git commit -m 'feat(desktop): one windowed, tail-following conversation list for every screen, with Jump to Latest

Value: protects=a long conversation mounts only rows near the viewport, follows the tail unless the builder reads above it, and offers Jump to Latest; fails_when=rows past the viewport mount, a new row yanks a reader, or the jump never shows; why_new=Plan’s transcript tests moved here with it, plus the jump and the entry rows it lacked; no_claim=that Plan maps its messages right (plan-entries tests)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 6: Plan renders its stored messages through the kit

**Files:**

- Create: `apps/desktop/src/views/shape/plan-entries.ts`, `apps/desktop/src/views/shape/plan-entries.test.ts`
- Modify: `apps/desktop/e2e/window-csp.spec.ts` (Step 4b), `apps/daemon/src/sessions/fake-plan-script.ts`
  (`scriptedShapeBehaviour`, where M2a moved it when it deleted `sessions/fake-shape.ts`: one scripted reply)
- Modify: `apps/desktop/src/views/shape/transcript.tsx` (it becomes a thin wrapper),
  `apps/desktop/src/views/shape/shape-view.test.tsx:280-304` (one assertion, below)
- Delete: `apps/desktop/src/views/shape/transcript.test.tsx` (its tests moved in Task 5; its mapping cases move to
  `plan-entries.test.ts`)

**Interfaces:**

- Consumes: `ConversationList`, `ConversationEntry` (Tasks 4 and 5); `Screenshot` (`views/shape/screenshot.tsx`).
- Produces:
  - `planEntries(messages: readonly ShapeMessageDto[]): readonly ConversationEntry[]`. The map, by kind and author
    (`packages/contracts/src/shape.ts:37-56`):

| message | entry |
| --- | --- |
| author `note`, any kind | `notice`, info |
| `text`, builder | `builder`, `extra: null` |
| `text`, claude | `reply`, `partial: false` |
| `tool` | `tool`, an `other` call by call 2: `status` `done`, `deniedBy` and `refusal` null; or, when the line's second segment is `refused`, `denied` with `deniedBy: '10db'` and the third segment as `refusal` (null when absent); `startedAt` the message's `createdAt`; `durationMs` and `parentId` null |
| `screen` | `custom`, rendering `Screenshot`, or nothing when the body doesn't parse (as `screenOf` does, `transcript.tsx:39-46`) |
| `propose` | `notice` "You pressed Propose." |
| `rehearse`, `event`, `notice` | `notice` with the body |
| `edit`, `digest` | nothing |

  - `Transcript` keeps its props (`TranscriptProps`, `transcript.tsx:15-19`) and renders
    `<ConversationList entries={planEntries(messages)} highlight={why} agentLabel="Agent" />` (call 15). `Block` and
    `blocksOf` go.

- [ ] **Step 1: Write the failing `plan-entries.test.ts` table**: one row per line of the map above, plus:
  - `propose_plan · 1 goal, 3 loose · passed` → `other`, `title` the whole line, `harnessTool` and `name`
    `10db.plan`, `inputPreview` the line
  - a 300-character line → `inputPreview` cut to 200, `title` whole
  - `Bash · refused · writes outside the checkout` → `denied`, `deniedBy: '10db'`, `refusal: 'writes outside the checkout'`
  - `propose_plan · refused` (no reason, `shape/tools.ts:147`) → `denied`, `deniedBy: '10db'`, `refusal: null`
  - `see_screen` (no ` · `) → `title` `see_screen`; an empty line maps to nothing (Review Focus 5)
  - every `tool` entry passes `ToolCallView.parse` (a validated boundary: the mapping builds a wire type)

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/shape/plan-entries.test.ts`
Expected: FAIL, because `./plan-entries` does not exist.

- [ ] **Step 3: Implement `planEntries` and rewrite `Transcript`.** Delete `transcript.test.tsx`.

- [ ] **Step 4: Run Plan's behaviour tests.** One assertion changes, by design: the tool line is now a row named
  by its words (UI spec §16: "rows replace the dimmed mono lines"). In `shape-view.test.tsx:303`, replace
  `getByText('propose_plan · 1 goal, 3 loose · passed')` with
  `getByRole('button', { name: 'Used propose_plan: 1 goal, 3 loose · passed' })`. Nothing else in `views/shape/`
  changes. If another Plan test fails, the production code is wrong.

Run: `pnpm --filter @10db/desktop exec vitest run src/views/shape src/conversation`
Expected: PASS.

- [ ] **Step 4b: Add the WebKit CSP row** to `apps/desktop/e2e/window-csp.spec.ts` (M3-2):
  - The fake Plan session (`scriptedShapeBehaviour` in `apps/daemon/src/sessions/fake-plan-script.ts`) answers a
    builder message containing "show a fence" with a reply holding a ```ts fence and the link
    `[docs](https://example.com/docs)`. No other script changes, so `shape.spec.ts` reads as before. M4b re-keys
    the fake's explore sessions by conversation (its call 20) and must keep this reply when it does, so
    `window-csp.spec.ts` stays green; the M3 PR says so for M4b's implementer.
  - `page.route` serves the app's HTML with `Content-Security-Policy: script-src 'self' 'unsafe-inline'`, with no
    `unsafe-eval` and no `wasm-unsafe-eval`. An init script records every `securitypolicyviolation` event.
  - A `page.on('request')` listener records URLs. None may contain `highlighted-body`, `mermaid` or `katex`
    (streamdown's own chunks).
  - In a Plan conversation, send "show a fence". The fence has coloured token spans (a `span` whose computed color
    differs from the block's), and no violation fired.
  - Click the link: the browser confirm "Open example.com in your browser?" shows, Cancel closes it, and
    `page.url()` is unchanged.

- [ ] **Step 5: Run Plan in WebKit, then click through.**

Run: `pnpm --filter @10db/desktop e2e shape.spec.ts see-screen.spec.ts window-csp.spec.ts`
Expected: PASS, with its axe scans.

  Then in `pnpm dev`, open a Plan conversation with a reply holding a heading, a list, a `ts` fence and a link.
  Check in light and dark: the reply is markdown, the builder's message is on its panel, a tool line is a row, the
  link asks before it opens, and Why? still highlights its rows. In `pnpm --filter @10db/desktop dev:shell`, check
  the link's native confirm and that Cancel opens nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/views/shape/plan-entries.ts apps/desktop/src/views/shape/plan-entries.test.ts apps/desktop/src/views/shape/transcript.tsx apps/desktop/src/views/shape/transcript.test.tsx apps/desktop/src/views/shape/shape-view.test.tsx apps/desktop/e2e/window-csp.spec.ts apps/daemon/src/sessions/fake-plan-script.ts && git commit -m 'feat(desktop): Plan renders its replies as markdown and its tool lines as rows, through the conversation kit

Value: protects=every Plan message kind maps to the row the kit draws, and refused tool lines read as stopped; fails_when=a kind is dropped or shown that was hidden, or a tool line loses its words; why_new=blocksOf was replaced, and its cases had no table; no_claim=that the rows look right in WebKit (shape.spec.ts and the click-through)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 7: The markdown decision, the docs, and the PR

**Files:**

- Create: `docs/architecture/decisions/./2026-11-12-agent-output-renders-as-hardened-markdown.md` (the commit's own
  date if later)
- Modify: `apps/desktop/AGENTS.md` (the Plan bullet's "Text from the model is rendered as plain text, never
  markup."; and a new bullet for the kit)

- [ ] **Step 1: Write the decision record**, with **Amends:** `decisions/2026-11-02-the-shape-view.md`. Decision:
  agent output in Plan, and in Sessions and the Workbench as they move onto the kit, renders as markdown through
  `conversation/markdown.tsx` alone, configured as spec §11 says (no raw HTML, sanitize then harden, no images,
  `https:` links only, each opened after a confirm, call 11's closing of a cut reply), and fences through
  `CodeHighlight` with Selenized Shiki themes on the JavaScript engine. Why: S10's reasons, research T4 §1's
  finding that the harden defaults are permissive, the CSP that rules out WebAssembly, and the alternative turned
  down (react-markdown plus `remend`, the fallback if the spike fails).

- [ ] **Step 2: Update `apps/desktop/AGENTS.md`.** In the Plan bullet, replace the plain-text sentence with "Replies
  render as markdown through the conversation kit (`conversation/`); the rest of the view's text is plain." Add one
  bullet: "`src/conversation/` is the conversation kit (sessions spec §8): `Markdown` (the only place streamdown is
  configured; `docs/architecture/decisions/./2026-11-12-agent-output-renders-as-hardened-markdown.md`), `ConversationList` (windowed,
  tail-following, over `ConversationEntry`, a view model each screen maps its DTOs to), `ToolCallCard` (rows from
  `tool-words.ts`; edits as one `Diff` per hunk beside `hunk-gutter.ts`'s numbers). A link opens through
  `openWebLink` (`docs/architecture/decisions/./2026-11-12-the-opener-opens-confirmed-https-links.md`). The kit never compares a
  harness id (ESLint)." Keep the Workbench's "never markup" text: it holds until M4c.

- [ ] **Step 3: Run the gate**

Run: `make gate`
Expected: `GATE PASS`.

- [ ] **Step 4: Commit the docs, push and open the PR**

```bash
git add docs/architecture/decisions/./2026-11-12-agent-output-renders-as-hardened-markdown.md apps/desktop/AGENTS.md && git commit -m 'docs: agent output renders as hardened markdown, through the conversation kit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
git push -u origin feat/sessions-m3
gh pr create --title 'feat(desktop): the static conversation kit, and Plan renders markdown' --body '<summary: the kit, the opener command, Plan on the kit; the e2e and click-through run; the calls list from the plan>

🤖 Generated with [Claude Code](https://claude.com/claude-code)'
```

  Before review, the PR has run: `shape.spec.ts`, `see-screen.spec.ts` and `window-csp.spec.ts` in WebKit, and the
  Task 6 click-through in `pnpm dev` and `dev:shell`.

## Review round 1: where each finding went

| # | Finding | Where it went |
| --- | --- | --- |
| M3-1 | `refusal` and `deniedBy` are on every `ToolCallView` (M2c) | Starting point; call 8; Task 4's `ConversationEntry`, `toolRowWords` and its denial rows; call 2 and Task 6's map and rows, with `propose_plan · refused` and no reason. M3 needs no contract change. |
| M3-2 | Nothing catches a Shiki that needs WebAssembly or eval | Task 3 Step 8 runs in `dev:shell` under the real CSP; Task 6 Step 4b adds the WebKit row (`script-src 'self' 'unsafe-inline'`, colored tokens, no violation, none of streamdown's own chunks requested); Task 2 Step 5 passes no `plugins` |
| M3-3 | `vi.mock` of 10db's own module | Task 2 Step 3: `mockIPC` in Tauri, and the browser confirm with `window.open` uncalled |
| M3-4 | "searched 0 times" | Task 4 Step 1's `groupWords` rows (reads only, searches only); Task 5 Step 1 |
| M3-5 | `data-message-id` | Task 5 keeps the attribute; `e2e/shape.spec.ts` unchanged |
| M3-6 | Dependencies and pipeline | Task 3 Step 1 (`@shikijs/langs`, `diff` exact with a held-back decision); `SHIKI_LANGUAGES` by module name; Task 2 Step 1 reads `defaultRehypePlugins` and harden's behaviour; Task 2 Step 5's GFM-only remark list and `rehypeAgentSafety` before harden; dollar and Mermaid rows |
| M3-7 | The opener | Task 1: the IDN row, `show` with a oneshot channel; Task 6 Step 4b asserts the URL is unchanged after a link click |
| M3-8 | The lint rule's reach | Task 5: three selectors (comparison, `case`, `.includes`), each proven red |
| M3-9 | `agentLabel` from M4b | Call 15 says M4b Task 18 must pass it |
| M3-10 | A 300-row tool turn | Starting point, morning check 5 |
| Parity | One line on account kinds | Global Constraints |

**Round 2 (final).**

| # | Finding | Where it went |
| --- | --- | --- |
| N1 | M2a deletes `sessions/fake-shape.ts` | Task 6: Files, Step 4b and the commit name `apps/daemon/src/sessions/fake-plan-script.ts` (`scriptedShapeBehaviour`), with no line reference; Step 4b notes that M4b keeps the "show a fence" reply when it re-keys the fake |

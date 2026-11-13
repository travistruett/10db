# Settings say what 10db connects to, what for, and whether it works

Status: designed. Builds on the accounts spec (`2026-10-17-10db-accounts-design.md`), the OpenRouter decisions
spec, the stakeholder questions spec (§10) and `decisions/2026-11-09-scope-follows-the-question.md`.

## 1. Why

The builder: "The 10db settings have gotten chaotic and I want things to be explicit, not implicit." Settings grew
one section per feature, so at 1280×720:

- the Settings sidebar shows nine project entries and only three of ten app-wide ones (Keep-awake, Updates, Lane
  permissions); Accounts, Integrations, Decisions and Models are below the fold;
- the app-wide list is in no order;
- one key lives under a feature: the OpenRouter key is a row in Decisions;
- two services have no UI at all: the Artificial Analysis key is set with `security add-generic-password` in a
  terminal, and GitHub with `gh auth login` in a terminal;
- Project › General mixes the project's fields with three Plan settings, each with its own save button;
- "Team" and "Personas and flows" hold model-by-role settings under names that say something else, and end in
  a line naming an internal plan;
- whether a connection works is spread across Settings badges, Inbox cards, Factory notes and lane cards.

Success: the builder can say, from Settings alone, what 10db connects to, what each connection is for, whether
it works right now, and what stops without it, and never needs a terminal to fix one.

## 2. Goals, non-goals, anti-goals

Goals:

- One rule for where a connection lives, and every connection placed by it.
- A Settings sidebar that fits 1280×720 and groups sections under subheads.
- Every connection shows its state and identity, and what is lost without it.
- The AA key and GitHub sign-in done from the app.
- Each feature page keeps its behaviour settings and shows one status line pointing at the connection it uses.

Non-goals:

- New behaviour settings. This moves, renames and explains what exists.
- OpenRouter running agents. Its account says it can't yet (§4.3).
- The team editor (personas, flows, human members).
- Slack avatars (blocked by the window's `img-src` CSP; a security-reviewed change of its own).

Anti-goals: any of these is a failure even if it technically works.

- A key that exists in two places, or a page that sends the builder to a terminal or the Keychain.
- A connection that looks fine while it is off, refused or unread. A daemon started with a `TENDB_*=off` switch
  says so on the card.
- A Settings sidebar that still needs scrolling to find a section at 1280×720.

## 3. The rule

**Sort by what the credential is, not by which feature uses it.** (The builder's call.)

- **Accounts** is model access: anything that pays for model calls. Claude plan, Anthropic API key, gateway,
  Bedrock, ChatGPT/Codex plan, and OpenRouter.
- **Integrations** is outside services that are not models: Slack, GitHub, Artificial Analysis.
- **Features pick an account**, the way a project already picks its agents' account in Billing. The judge picks
  in Decisions.
- What has no sign-in is data or downloads and has no card: models.dev (status in Models), the Claude Code and
  Codex copies and self-update (status in Updates), Playwright's browser (status in the project's pictures
  line).
- A project's repo MCP servers and git remotes stay with the project (Trust, the Inbox). People are who, not how.

Why OpenRouter is an account, not an integration: it pays for model calls, and it could run agents. Sorted by role
its one key would sit under Decisions today and under Accounts later. As model access it is one account; the
judge picks it, and running agents becomes a capability the account gains, not a move between pages.

## 4. Information architecture

### 4.1 The Settings sidebar shows one scope at a time

Under Back to Board, a two-option `SegmentedControl` picks the scope: **This project** or **All projects**. The
list below shows that scope's sections only, under subheads. The main sidebar's two entries already split this
way: Project Settings opens This project › General, Settings at the foot opens All projects › Overview. The
URL keeps one route per section (`/settings/<section>`), and the scope follows the section, so a link to any
section lands with the right scope selected.

This amends `DESIGN.md`'s line "The Settings sidebar keeps the same order (Back to Board, the project's
sections, then Global)": the order holds, and the scope switch shows one half at a time. My call, made to fit
1280×720; the alternative (both scopes, subheads, scrolling) still hides most of the app-wide half.

### 4.2 Sections

This project (the project switcher sits under the scope switch, as today):

| Subhead | Section | Holds |
|---|---|---|
| Project | General | name, gate and check commands, app address and preview, pictures of pages, delivery, running tasks, Advanced |
| | Board columns | as today |
| Planning | **Planning** (new) | the Jev opt-in, one-way paths, the small-proposal limit (moved from General) |
| | Areas and hazards | as today |
| | Who Answers | as today |
| Agents | Billing | the account, backup account and switch-at, as today |
| | **Models by role** (was Team) | the model by role and patterns, as today |
| | Trust | as today; the "Comes along" and "Left out" lists start collapsed (§4.6) |
| | Network hosts | as today |

All projects:

| Subhead | Section | Holds |
|---|---|---|
| (none, first) | **Overview** (new) | every connection's state at once (§5) |
| Models | Accounts | model access, OpenRouter included (§6) |
| | Models and benchmarks | as #588 leaves it, plus a status line (§8.2) |
| | Decisions | the judge's settings, with Runs on (§8.1) |
| | **Models by role** (was Personas and flows) | the model by role and patterns, as today |
| Agents | Lane permissions | as today |
| | Trust | as today |
| Connections | Integrations | Slack, GitHub, Artificial Analysis (§7) |
| | People | as today |
| This Mac | Updates | as today |
| | Keep-awake | as today |

The builder agreed to four app-wide subheads, Models / Agents / Connections / This Mac. Moving Personas and flows,
renamed, from Agents to Models is my call: what the section holds today is models. The project-scope subheads and
the order inside each subhead are my call too.

Each subhead is a dimmed `xs` label, like today's "Project" and "Global"; each nav link keeps its icon.

**A section in both scopes says which one it is.** Trust and Models by role exist in both. Each of the four pages
has a dimmed line under its title naming its scope and how the two relate: "For Renewals only. Anything set to As
app follows All projects › Trust." and "For every project. A project can override this in its own Trust."
(Models by role says "Use global" and "10db default" the same way.)

### 4.3 What isn't built yet

A section with a remainder ends with one dimmed line: "Not built yet: which persona runs each role, and the
project's human members." No plan names, no "Still to come". (The builder's call.) `SettingsSection.planned`
holds that text.

### 4.4 Planning

A project section with three settings, each as it works today, under one description: "How Plan treats this
project's work before a lane starts it." The Jev opt-in names where messages go and links there: "Sends your
brainstorm messages, not code, to the account decisions run on (OpenRouter · <label>)." With no account picked
for decisions, the switch is disabled and says "Pick an account for decisions first" with a link to Decisions.

### 4.5 General

General loses the three Plan settings and keeps its one form and its one sticky Save. Nothing else changes.

### 4.6 Project › Trust

"Comes along" and "Left out" start collapsed under a line saying how many items each holds and a Show control.
They hold hundreds of rows on a builder's real machine.

## 5. Overview

Opens All projects. Read-only; every row links to the card or section that fixes it.

The first line under the title answers "is anything broken?": "All 9 connections work." or "2 need you:
Claude plan, Artificial Analysis.", each name a link that scrolls to and focuses its row. Off rows are not counted
as needing the builder. Then three groups, one row each:

- **Model access**: every unarchived account. Name, kind, state (the badge Accounts shows) and "Used by: …"
  (§6.2).
- **Services**: Slack, GitHub, Artificial Analysis, each with its card's state line (§7).
- **Data and downloads**: models.dev ("660 models · fetched 2 min ago"), Claude Code and Codex copies ("2.1.302 ·
  ready"), self-update ("Runs from source, never updates itself" or its state).

A row's state is one of `ok`, `needs you` or `off` (a `TENDB_*=off` switch, or turned off in Settings), shown as
a coloured dot and words. Rows that need the builder sort first within their group. The page is built from the
queries the cards already use (`/accounts`, `/judge`, `/slack`, `/github`, `/benchmarks/status`, `/models/status`,
`/system`, `/settings/self-update`); it adds no route. A row whose query fails says "Couldn't read this" with a
Retry, never a stale green.

## 6. Accounts

### 6.1 OpenRouter is an account kind

A new account kind `openrouter`: a label and a key. Its secret is the account's own Keychain item
`account:<id>` with the fingerprint check every account secret has. It has no monthly cap, no lane cap, no
config dir and no tier overrides. Add Account offers it as "OpenRouter key", with a checkbox, on by default,
"Run decisions on this account" when decisions run on no account yet.

The account drawer carries Test, the one tiny call Decisions makes today, so a key is checked where it is set.

**Moving the existing key.** On start, with `TENDB_JUDGE` on: if the Keychain holds `openrouter-api-key` and no
`openrouter` account exists, 10db creates an account labelled "OpenRouter", writes the key to its
`account:<id>` item, reads it back, records the fingerprint, sets decisions to run on it, and only then removes
`openrouter-api-key`. A failure before the removal leaves the old item in place and retries on the next start. A
daemon with `TENDB_JUDGE=off` reads neither item. The account kind is a `text` column with no CHECK, so no
migration. My call over an account type that reads the old item: one key in one place, under the same rules as
every other account secret.

### 6.2 Each account says what uses it and what it can't do

The account row and drawer show:

- **Used by**: the projects whose account or backup account it is ("Renewals' agents", "Renewals' backup") and
  "decisions" when the judge runs on it. "Used by nothing" when nothing does.
- **Can't do yet**, when it applies: an OpenRouter account says "Can't run agents yet". Billing's account and
  backup selects list it disabled with that reason; Decisions' Runs on lists every other account disabled with
  "Decisions run on OpenRouter for now".

That is the provider-parity rule: a gap is stated, never hidden.

### 6.3 Per provider

| Account kind | Runs agents | Runs decisions | This month |
|---|---|---|---|
| Claude plan | yes | no, "Decisions run on OpenRouter for now" | tokens, as today |
| Anthropic API key, gateway, Bedrock | yes | no, same | tokens and dollars, as today |
| ChatGPT/Codex plan | yes | no, same | tokens, as today |
| OpenRouter | no, "Can't run agents yet" | yes | dollars from the decision call log |

Decisions work the same whichever account a project's agents use: the judge's account is separate from the
project's.

## 7. Integrations

One card per service, in a fixed order: GitHub, Slack, Artificial Analysis. Every card has the same four parts, in
this order top to bottom:

1. **Header**: the mark and the service's name on the left; **state and identity** on the right, a status dot
   and one line.
2. **For**: one line on what 10db uses it for.
3. **Actions**: connect, replace or remove, as the service allows.
4. **Without it**: one dimmed `xs` line on what stops, always shown, connected or not.

A daemon started with the service's `TENDB_*=off` switch shows the card with state "Off: 10db was started with
TENDB_X=off" and no actions.

**Brand marks.** A card, an account row and an Overview row show the service's or provider's mark where
`@tabler/icons-react` (3.50, already a dependency) has one: `IconBrandGithub`, `IconBrandSlack` (already on the
Slack card), `IconBrandOpenai` for the ChatGPT/Codex plan and `IconBrandAws` for Bedrock. Tabler has no mark for
Anthropic, OpenRouter or Artificial Analysis. Those take a neutral Tabler icon (`IconKey` for a key, `IconGauge`
for AA), and AA keeps its linked name, as `ArtificialAnalysisCredit` gives it today. The repo holds no AA logo
file; adding one needs AA's own asset and a check of its terms, so it is a follow-up. Decision 65's "carries AA's
logo" is met today by the linked name, and this spec doesn't change that.

### 7.1 GitHub

- For: "Opens pull requests, watches their checks, and finds new 10db builds."
- State: "Signed in as travistruett" · "Not signed in" · "gh isn't installed" · "Couldn't reach GitHub".
- Actions: **Sign In** when signed out, **Switch Account** when signed in, **Check Again** always. No sign-out:
  gh's login is the Mac's, shared with the builder's terminal, and the card says so: "This is gh's own login, the
  same one your terminal uses."
- Without it: "Pull requests, CI checks and self-update stop; projects can still commit directly."
- gh isn't installed: the card says where 10db looks (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`) and to
  install it with Homebrew, then Check Again. Installing a tool is the one step the app can't take.

Sign In runs `gh auth login --web --hostname github.com --git-protocol https --skip-ssh-key` with no terminal. gh
then prints the one-time code and `https://github.com/login/device` and waits (checked against gh 2.83.2). The
daemon reads both from gh's output, the card shows the code with a Copy button and opens the page, and the card
updates when gh exits: signed in as the new login, or the error gh gave. A Cancel stops gh. Ten minutes without
an answer stops it too. One sign-in runs at a time.

New routes: `GET /github` (state, login, checkedAt; probed on request and on Check Again, never in a screen's
frame), `POST /github/signin` (returns the code and URL), `DELETE /github/signin`. The end arrives as an event on
the existing event stream, as an account's Connect does. `isSignInUrl` grows `github.com/login/device`.

### 7.2 Slack

As built, plus the four-part layout: For "Asks the people who answer your questions, and reads their replies.";
Without it: "Questions for other people stay in your Inbox; nothing is sent." (With no connection a question's draft is still written, but no post is attempted and none can be made by hand, so the card stays the builder's.)

### 7.3 Artificial Analysis

- For: "Scores each model's intelligence and speed, so 10db can pick a model for each role."
- State: "Key set · synced 2 h ago · <n> models" · "No key" · "AA refused this key" · "Rate limited, retrying" ·
  "Sync failed: <message>".
- Actions: a key field with Set Key or Replace Key, Remove Key, and Sync Now.
- Without it: "Models are compared without scores: each role takes its tier's model at its default effort." (With no scored profile routing falls back to the role's default effort inside the tier's pool, and a floor raises the step to the pool's top model, one effort up.)
- The card carries AA's name and link, as `ArtificialAnalysisCredit` does, per AA's attribution terms. No AA
  number appears in the repo, fixtures or docs.

New routes: `PUT /benchmarks/key` and `DELETE /benchmarks/key`. Setting a key writes the Keychain item
`artificial-analysis-api-key` and starts a sync; the response is the status after that sync starts. The card's
"key set" reads the Keychain, not the last sync's record, so a key set a second ago shows as set.

## 8. Feature pages point at their connection

### 8.1 Decisions

The OpenRouter key row and Test leave Decisions. The page opens with:

- **Runs on**: a select of accounts (§6.2), saved to the judge config's new `accountId`. Beside it, the account's
  state: "Key set" or the account's badge, linked to the account.
- With no OpenRouter account: "No account can run decisions yet." and an **Add OpenRouter Account** button
  opening Add Account with that kind chosen.
- `TENDB_JUDGE=off` keeps its banner.

Then, unchanged in behaviour: the master switch, the review decision, Plan's decisions, Recent decisions. The judge
reads the key of the account it runs on, through the same secret check launches use; an archived account, a
missing secret or no account means `no_key`, as today.

### 8.2 Models and benchmarks

After #588 merges: under the catalogue line, "Scores from Artificial Analysis · synced 2 h ago · Manage", where
Manage opens Integrations › Artificial Analysis. With no key: "No Artificial Analysis key: models are compared
without scores · Add Key".

## 9. Nothing sends the builder to a terminal

- Inbox `benchmark-key`: "Replace the key in Settings › Integrations." with an **Open Integrations** button.
- Inbox `slack-refused`: the same button.
- Lane cards that say "Run gh auth login in a terminal" (`delivery/cards.ts`, self-update's message): "Sign in to
  GitHub in Settings › Integrations." The card's link opens it.
- First run's gh row: a Sign In that runs §7.1's flow inline, and "Not signed in" without a command.
- A missing tool (Inbox `missing-tool`, the gh card) is the exception: it says where to install it.

**Every link lands on its target.** A link names what it points at (`/settings/integrations?focus=github`,
`/settings/accounts?focus=<account id>`, `/settings/decisions?focus=runs-on`). The page scrolls the target into
view and moves keyboard focus to its first control; an account target opens that account's drawer, as clicking
its row does. An unknown target opens the section's top. (The builder's call.)

**No notices.** Nothing in this work adds a one-time notice, banner or "what's new" line, the moved OpenRouter key
included: the account appears in Accounts with "Used by: decisions", and Decisions shows Runs on. (The builder's
call.)

## 9a. States

What the builder sees, per surface:

| Surface | Loading | Empty | Error | Success | Partial |
|---|---|---|---|---|---|
| GitHub Sign In | Sign In shows its loader until gh prints the code (≤ 5 s), then the card shows the code in large monospace with Copy, "Waiting for you to approve in the browser…", Open Page Again and Cancel | n/a | gh's own message beside Sign In, which stays to retry; a page that won't open says so and keeps the code on screen; ten minutes says "Sign-in timed out" | The header turns teal, "Signed in as <login>", with a dimmed "just now"; the code block closes | n/a |
| GitHub status | the header shows "Checking…" in dimmed text | "Not signed in" (yellow) with Sign In as the card's one filled button | "Couldn't reach GitHub" (yellow) with Check Again; never shown as signed out | "Signed in as <login>" (teal) | gh installed, not signed in: as Empty |
| AA key | Set Key shows "Checking the key…" until the first sync after it answers | "No key" (yellow), the key field and Set Key filled | "AA refused this key" (yellow) beside the field, which is kept for a corrected paste; rate limited and failed are dimmed `xs` lines, per DESIGN.md's alerts rule | "Key set · synced just now · <n> models" (teal); the field clears | key set, sync failed: teal "Key set", then a dimmed line with the failure and "Routing uses the last good scores" |
| Overview | one skeleton row per expected row, at the rows' height | n/a: the default Claude plan always exists | the row says "Couldn't read this" with Retry; the summary line counts it as needing the builder | as §5 | each row loads on its own; the summary line waits for all |
| Decisions › Runs on | the select is disabled with a loader | no OpenRouter account: "No account can run decisions yet." with Add OpenRouter Account, the page's one filled button | the account's secret is missing or changed: its badge and "Set the key again in Accounts", linked | the select and "Key set" | n/a |
| OpenRouter account Test | Test shows its loader | n/a | OpenRouter's message beside Test | "Works · 340 ms · $0.0001" beside Test, kept until the drawer closes | n/a |

## 9b. Layout, colour and access

Layout at 1280×720, All projects › Overview:

```
┌ Settings sidebar 200px ┐┌ Overview ──────────────────────────────────────────────────┐
│ ← Back to Board        ││ 2 need you: Claude plan, Artificial Analysis.               │
│ [This project|All proj]││                                                             │
│ ● Overview             ││ Model access                                                │
│ Models                 ││ ┌─────────────────────────────────────────────────────────┐ │
│   Accounts             ││ │ Claude plan   ● Needs sign-in   Used by: Renewals' agents›│ │
│   Models and benchmarks││ │ OpenRouter    ● Key set         Used by: decisions ·     ›│ │
│   Decisions            ││ │                                 Can't run agents yet     │ │
│   Models by role       ││ └─────────────────────────────────────────────────────────┘ │
│ Agents                 ││ Services                                                    │
│   Lane permissions     ││ ┌ ◆ Artificial Analysis ● No key  Models compared without… ›┐│
│   Trust                ││ │ ◆ GitHub      ● Signed in as travistruett                ›││
│ Connections            ││ │ ◆ Slack       ● Off: started with TENDB_SLACK=off        ›││
│   Integrations         ││ └─────────────────────────────────────────────────────────┘ │
│   People               ││ Data and downloads                                          │
│ This Mac               ││ │ models.dev ● 660 models · fetched 2 min ago …             │
│   Updates              ││                                                             │
│   Keep-awake           ││                                                             │
└────────────────────────┘└─────────────────────────────────────────────────────────────┘
```

Each Overview group is one bordered list (`SettingRow`'s border and dividers), not a card per row. A row is the
mark (16 px), the name, the status dot and its words, a dimmed `xs` second line, and a chevron; the whole row is
the link.

**Status colours:** teal = works (the builder prefers teal to green for status; this amends `DESIGN.md`'s green-only rule for connection status, and task and goal colours keep green), yellow = needs the builder (signed out, no key, refused,
couldn't reach, couldn't read), gray = off (a `TENDB_*=off` switch, or running from source for self-update).
Red is not used: nothing here has failed in the sense a task fails. A dot always comes with words. 

**Access** (my calls):

- The scope switch is a Mantine `SegmentedControl` (a radio group: arrow keys move, the choice has a visible focus
  ring). Changing scope navigates to that scope's first section (General, or Overview).
- Each subhead is a group label: the links under it sit in an element with `role="group"` and `aria-labelledby`
  the subhead.
- The status line on a card and an Overview row is plain text beside the dot, so a screen reader reads "GitHub,
  signed in as travistruett"; the dot is `aria-hidden`.
- The GitHub one-time code and the sign-in's waiting and ending lines sit in an `aria-live="polite"` region.
- Every action is a real button or link, reachable by Tab, in reading order.
- Light and dark both use theme tokens only; `/design-review` checks both.

The app is a desktop window: the layout is designed at 1280×720 and must not break down to 1024×700, where the
Overview's second line wraps under the status rather than truncating. No mobile layout. (My call.)

## 10. Folded in from #587

- People's daily limit takes whole numbers only.
- Removing a person asks first ("Remove <name>? Their open questions go to the Inbox.").
- Who Answers' judge-off line reads as stakeholder spec §10.4 says.

Left as follow-ups: Slack avatars (CSP), pre-selecting the builder in "Which one is you?", a removed person's
reused handle.

## 11. Docs this amends

- A decision file, `decisions/2026-11-12-settings-sort-by-what-the-credential-is.md`, amending
  `decisions/2026-10-31-openrouter-makes-routine-decisions.md` (the key's status moves from Decisions to an
  account) and decision 65 (the AA key gets a UI; its logo rule holds), and recording the one-scope sidebar.
- The accounts spec: the `openrouter` kind, its capabilities and Used by.
- Stakeholder spec §10.1: Integrations' card order and four-part layout.
- `DESIGN.md`'s Settings sidebar line, per §4.1.
- The README's AA key instructions point at Settings › Integrations.

## 12. Constraints

- No migration. If one turns out to be needed, stop and say so.
- `TENDB_JUDGE`, `TENDB_BENCHMARKS` and `TENDB_SLACK` off read no Keychain item of theirs, as today.
- Keychain writes go through the `Keychain` module; no secret on a command line or in the database.
- Every surface fits 1280×720 without the sidebar scrolling.
- #588 owns the Models page until it merges; §8.2 builds after it.

## 13. Left to the builder of this plan

- Exact copy beyond what is quoted here, within `DESIGN.md`'s voice.
- Icons for the new sections and subheads.
- Where Test's result shows in the account drawer.

## Design Review Completion Summary

```
+====================================================================+
|         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
+====================================================================+
| System Audit         | DESIGN.md present; UI scope: Settings IA,   |
|                      | Overview, Integrations, Accounts, Decisions |
| Step 0               | 6/10, all 7 passes, weight on new screens   |
| Pass 1  (Info Arch)  | 7/10 → 9/10 after fixes                     |
| Pass 2  (States)     | 4/10 → 9/10 after fixes                     |
| Pass 3  (Journey)    | 6/10 → 9/10 after fixes                     |
| Pass 4  (AI Slop)    | 8/10 → 9/10 (lists, not card grids)         |
| Pass 5  (Design Sys) | 7/10 → 9/10 (status colours, tokens)        |
| Pass 6  (Responsive) | 4/10 → 8/10 (desktop sizes, a11y)           |
| Pass 7  (Decisions)  | 7 resolved, 0 deferred                      |
+--------------------------------------------------------------------+
| NOT in scope         | written (4 items)                           |
| What already exists  | written                                     |
| TODOS.md updates     | 0 items proposed                            |
| Approved Mockups     | 0 generated (no image key), 0 approved      |
| Decisions made       | 6 by the builder, 4 marked as my calls      |
| Decisions deferred   | 0                                           |
| Overall design score | 4/10 → 8/10                                 |
+====================================================================+
```

Builder's decisions in this review: all 7 passes; the Overview summary line; the card order with "Without it"
always shown; a scope line on same-named pages; the state table; no notice for the key move, and no notices at
all; links land on their target. My calls, after the builder said they are the only user and wants fewer
questions: status colours, access, desktop sizes, Overview as bordered lists.

NOT in scope: mockup images (the designer has no image key); a mobile layout (a desktop window); an AA logo file
(needs AA's asset and terms); a badge on the Overview link (a notice by another name).

What already exists: `SettingRow` and its bordered lists, the Slack card's connected and setup states,
`AccountSelect` with disabled options, `CountBadge`, `ArtificialAnalysisCredit`, the Connect flow and its
`account.login_ended` event, the `Keychain` module.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | — | Independent 2nd opinion | 0 | skipped (builder's call) | — |
| Eng Review | `/autoplan` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score: 4/10 → 8/10, 10 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** design outside voices skipped by the builder (D2); no Codex or subagent design read.
- **VERDICT:** Design Review CLEAR (PLAN). The engineering read is the repo's plan review of the implementation plan.

NO UNRESOLVED DECISIONS

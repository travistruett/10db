# Watchpoints in Settings: All Projects owns the list, a project follows it

**Size: Feature** (desktop only; the routes exist). One implementer builds it end to end, then one review that blocks
only on bugs, then screenshots for the builder. The design follows Settings' own precedent for a concept at both
scopes, **Trust**: All Projects › Trust holds the switches, and a project's Trust shows each one as "Default · On" /
On / Off.

## Brief

**What changes for you.**
- **All Projects › Watchpoints** (new, under Agents, after Trust) is where your watchpoints live: add, edit and remove
  them, and pick each one's **When It Matches** (Show or Ask). Its scope line reads "For every project; a project can
  override one or add its own."
- **This Project › Watchpoints** shows **one table**: every watchpoint that applies here, then the project's own.
  - Yours carry a **When It Matches** choice of **Default · Ask** / Show / Ask / Off. Default follows All Projects;
    Show or Ask overrides it here only; Off turns it off here only. The scope line reads "Default follows All
    Projects › Watchpoints", with a link.
  - Editing one of yours here makes a project copy, marked dimmed "set here", and the drawer has **Use Default**
    to drop it. Nothing on a project page changes another project.
  - The project's own watchpoints have Show / Ask, and they can be removed.
- Both pages use the usual heading: the title, one short line ("Changes you want to judge yourself."), the long text
  behind the ⓘ hint, and one **Add Watchpoint** split button whose menu lists the library's starters.
- "Loudness" becomes **When It Matches**. Hold is hidden until it is built, instead of showing disabled on every row.
  Labels are Title Case. The table fits the window. Paths use the shared path cell, with a hover list.

**What it buys.** Watchpoints work like every other setting you have at two scopes, and a project page can't
quietly change all your projects.

**What could go wrong, and how we'd know.**
- *An override goes stale.* A project copy doesn't follow later edits to yours, the same as today. The "set here"
  marker and Use Default make it visible.
- *A link to Settings › Watchpoints* (in For You, a card, or a doc) lands on the wrong scope. Keep the project
  section's key, and add a new key for the All Projects page.

**Calls you might disagree with.**
- The parent scope is called **Default**, as on Trust. The project Playbook's "Global" is the odd one out, and
  changing it is not this task.
- Last 30 Days stays on the project page only: the counts are per project.

**Needed from you:** nothing. Screenshots come before merge.

## Provider parity

UI only. It is the same on every provider.

## Parts

1. **Sections** (`views/settings/sections.ts`, `settings-nav.tsx`, `section-body.tsx`):
   - Add an App section "Watchpoints" in the Agents group, after Trust, with a new key; the project key is unchanged.
   - Add `ScopeLine`s for both pages, in `section-body.tsx` beside Trust's. The project line's "All Projects ›
     Watchpoints" is a link to the app page.
2. **The All Projects page** (`all-watchpoints-section.tsx` or similar):
   - It edits `GET`/`PUT /settings/watchpoints`, using `SectionHeading` (title, one line, help) and a `SplitButton`
     "Add Watchpoint". The menu is a "From the Library" `Menu.Label` with each starter not in the list, or one
     disabled "Every starter is in your list".
   - The DataTable sits in a `RaisedPanel`. Columns: Watchpoint (label, why dimmed), Matches (`PathSummary` plus
     "+ N line patterns"), When It Matches (Show / Ask), and `RowActions`.
   - Remove uses the `ConfirmModal` already in place.
3. **The project page** (`watchpoints-section.tsx`), rebuilt as one table over `effective` plus the off entries,
   in the order yours come first, then the project's own:
   - Columns: Watchpoint (label and why; a "This Project" pill on the project's own; dimmed "set here" on an
     override), Matches, When It Matches, Last 30 Days, and `RowActions` (Edit; Remove only on the project's own).
   - **When It Matches** for yours is a `SegmentedControl`: `Default · <the yours value>` / Show / Ask / Off.
     - Default drops the project entry.
     - Show or Ask writes an override: a copy of yours with that value.
     - Off writes `{ key, off: true }`.
     The project's own get Show / Ask. Follow `project-trust-section.tsx`'s `choices`/`setOrClear`.
   - "Add Watchpoint" adds a project watchpoint, and its library menu adds a starter as a project watchpoint.
   - A project page never PUTs `/settings/watchpoints`. Remove `withLoudness`'s write to your list and the drawer's
     "Applies to" choice. Remove `watchpoint-lists.ts` helpers that become dead.
4. **The drawer** (`watchpoint-drawer.tsx`), shared by both pages:
   - Fields: Name, Why It Matters, Matches These Paths (with the checkout's matching count on the project page
     only), Lines, What to Check, When It Matches.
   - On one of yours opened from a project page, it says "Changes apply to this project only" and shows **Use Default**
     when it is an override.
   - The Lines placeholder becomes "One pattern per line", not example regexes.
5. **Copy:** Title Case for labels, column headers ("Last 30 Days") and pills. Use "Add Watchpoint", "Save Watchpoint"
   and "Remove Watchpoint". Remove the word "Yours" as a scope label. Hold isn't offered in either control; the type
   keeps it.
6. **Docs:** the settings `AGENTS.md` notes for both sections. Fix its stale `HelpTip` reference to `HelpHint`. Update the
   watchpoints spec's § Surfaces "Settings › Watchpoints" to match.

## Tests

- Extend the e2e flow that seeds a watchpoint (`apps/desktop/e2e/loop.spec.ts` flow 2, or `settings` if there is a
  watchpoints step). Set one of yours to Ask on the All Projects page; on the project page, set it to Off, then back
  to Default. Assert the project's list and yours through the API. Update the selectors the copy changes break.
- No rendered-component tests and no unit tests: the list logic is a small UI mapping.

## Done

- Typecheck, lint, and the related desktop tests pass. The touched e2e specs pass. `make precheck` exits 0.
- Then the lead takes screenshots (dark and light, both pages, the drawer, and the split-button menu), runs one review,
  and opens a PR with auto-merge.

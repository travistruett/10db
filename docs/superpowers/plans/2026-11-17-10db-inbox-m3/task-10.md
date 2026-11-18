# Task 10 (M4): the Workbench queue in the panel

**Spec:** app shell spec:
- §1.3 The panel ("Who has a panel": UI Workbench, a pass open);
- §2 Widths ("The Workbench's queue strip");
- §3 Keyboard ("Workbench");
- §4.2 UI Workbench.

**State rows:** none in the Inbox table. Its own cases are the five layouts below.

It runs after M3 merges into the integration branch, by the same implementer, in the same worktree.

## Files

- Shared files, one hunk each:
  - `apps/desktop/src/shell/frame-slots.ts`: the field;
  - `apps/desktop/src/shell/app-frame.tsx`: `panelShown: layout.panel === 'column' || layout.panel === 'overlay'`
    in the slots' value;
  - `apps/desktop/src/screens/render-layout.tsx`: `panelShown: true`;
  - `apps/desktop/src/test/frame.tsx`: a `panelShown` prop on `FrameSlots`, default `true`;
  - `useFrameSlots`' fallback: `panelShown: false`.
- Modify, in `apps/desktop/src/views/workbench/`:
  - `pass-workspace.tsx`;
  - `pass-header.tsx`;
  - `workbench-view.tsx` (where `PassHeader` is drawn);
  - `pass-workspace.test.tsx`;
  - `pass-header.test.tsx`;
  - `AGENTS.md`.
- Delete `views/workbench/workbench-layout.ts` and `workbench-layout.test.ts`. Their only use was where the queue
  sits.

## Interfaces

Implement this:

```ts
// M4: apps/desktop/src/shell/frame-slots.ts — FrameSlots gains
//   readonly panelShown: boolean;   // the frame draws the panel now: a column, or the open overlay
```

Call these, from M1, as they are on main (`shell/panel.tsx`, `shell/title-row.tsx`):

```ts
export function Panel({ section, children }: { readonly section: RailSection; readonly children: ReactNode }): ReactNode;
export function TitleRow({ title, meta, switcher, actions, lines }: { readonly title: ReactNode;
  readonly meta?: ReactNode; readonly switcher?: ReactNode; readonly actions?: ReactNode;
  readonly lines?: 1 | 2 }): ReactNode;
```

## What to build

- **With a pass open,** `PassWorkspace` always mounts `Panel section="workbench"`, so the frame knows the section
  has a panel. The panel holds:
  - **the head:** the pass's name (14 px, weight 600) and its ⋯ menu (Close Pass, Rename, Abandon Pass, as
    `PassHeader` has them). Under them is one dim line of `headerLine`'s counts without the project and pass
    names. The pull request control and its reason are on a row of their own when offered;
  - `QueueList`, unchanged, in the queue's order;
  - Add Page, the dashed row at the foot, unchanged.
- **When `panelShown` is false,** meaning folded or hidden with ⌘\, the workspace draws today's narrow strip, the
  `QueueList` box across the top. The panel's `Panel` is still mounted, so the frame keeps its sidebar button, but
  it renders nothing inside. The queue is never drawn twice.
- **The title row.**
  - With `panelShown`, it holds the shown page: its label as the title, its state words (`pageStatus` → the queue
    row's state line) as `meta`, and the row's `RowMenu` (Take Out) as the actions.
  - Without `panelShown`, `PassHeader` draws into the title row as today.
- **The header's notices** (`HeaderNotices`) stay at the top of the surface in both cases.
- The workspace's wide layout and its 220 px queue column go. The thread fills the content.
- **Keys:** `j`/`k`, `n`, ⌘L and Esc keep working. The queue's `ref` and `QUEUE_ATTRIBUTE` reach the rows through
  the portal. Esc in a field returns to the shown page's row, in the panel or the strip.

## Steps

1. **Red.** In `pass-workspace.test.tsx`, a table of layouts through `FrameSlots` and `observeWidthsOf`. Each row
   asserts exactly one `list` named "Open pages", where it is, and what the title row holds:
   - the panel shown → the list in `[data-testid=panel]`, and the title row names the shown page;
   - the panel hidden (`panelShown` false) → the list in the content, and the title row holds the pass line and ⋯;
   - a medium window, the overlay closed → the strip;
   - the overlay open → the panel;
   - a narrow window → the strip.

   `j` moves focus along the rows in the panel. In `pass-header.test.tsx`, the head and the title row forms each
   keep their actions.
2. Implement, then make it green. Run `pnpm --filter @10db/desktop exec vitest related src/views/workbench
   src/shell/frame-slots.ts src/shell/app-frame.tsx --run --maxWorkers=2`, then typecheck and lint the desktop.
3. Update `views/workbench/AGENTS.md`:
   - the queue is in the panel, with the strip when the panel isn't shown;
   - `workbenchLayout` is gone;
   - the pass's name and ⋯ are in the panel's head.
4. Commit the files above, the deletions included, with the message `feat(desktop): the workbench queue in the
   panel`. The body carries:

   ```
   Value: protects=the queue shows once, in the panel or the strip, at every width; fails_when=the
     queue is drawn twice, or vanishes when the panel is hidden; why_new=the queue's place was
     the workbench's own width rule; no_claim=the e2e sweep (task 11)
   ```

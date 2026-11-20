import { MenuAction } from './menu-action';
import {
  InboxKind,
  InboxState,
  PassNoticeKind,
  PassSignOff,
  PassState,
  type InboxItemDto,
  type PassViewDto,
  type ProjectViewDto,
} from '@10db/contracts';
import { ActionIcon, Menu, Stack, Text } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { CloseProgress } from './close-progress';
import { useMergeTo } from './pr-button';
import { PageStatus, pageStatus } from './page-status';
import { useFrameSlots } from '../../shell/frame-slots';
import { TitleRow } from '../../shell/title-row';
import { passTitle } from './pass-title';
import { medianTurnMinutes, timingLine } from './timing';

// Workbench spec §4.3: the pass header holds the pass's own actions; a page's actions are on its own
// title row (or bar, in a narrow window), so the two never share a bar.

/** What the header counts, in its order, and the statuses each count takes in. */
const COUNTS: readonly { readonly words: string; readonly of: readonly PageStatus[] }[] = [
  { words: 'committed', of: [PageStatus.SignedOff] },
  { words: 'signing off', of: [PageStatus.SigningOff, PageStatus.Waiting] },
  { words: 'ready', of: [PageStatus.Ready] },
  { words: 'asking', of: [PageStatus.Asks] },
  { words: 'failed', of: [PageStatus.Failed] },
  { words: 'preview broken', of: [PageStatus.PreviewBroken] },
  { words: 'working', of: [PageStatus.Working, PageStatus.Paused] },
];

/** "2 committed · 1 ready": zero counts and pages not started left out; empty when nothing counts. */
export function countsLine(statuses: readonly PageStatus[]): string {
  return COUNTS.flatMap(({ words, of }) => {
    const count = statuses.filter((status) => of.includes(status)).length;
    return count === 0 ? [] : [`${String(count)} ${words}`];
  }).join(' · ');
}

/** "ampsio · Settings and People · 2 committed · 1 ready": zero counts and pages not started left out. */
export function headerLine(project: string, pass: string, statuses: readonly PageStatus[]): string {
  return [project, pass, countsLine(statuses)].filter((part) => part !== '').join(' · ');
}

/** What the pass's own menu does; Finish is offered only with `onClose`. */
export interface PassActions {
  /** Without it there is no Close Pass. */
  readonly onClose?: () => void;
  readonly onAbandon: () => void;
}

export interface PassHeaderProps extends PassActions {
  readonly project: ProjectViewDto;
  readonly view: PassViewDto;
  /** The open Inbox items: a page's question or permission targets its run. */
  readonly inbox: readonly InboxItemDto[];
  /** Now, in epoch milliseconds. */
  readonly now: number;
  /** Open Pull Request, shown once a page is signed off; without it there is none. */
  readonly pullRequest?: ReactNode;
}

/** When each open question or permission of the pass's pages was raised. */
function askingSince(view: PassViewDto, inbox: readonly InboxItemDto[]): string[] {
  const runs = new Set(view.pages.flatMap((page) => page.workstreamId ?? []));
  return inbox
    .filter(
      (item) =>
        item.state === InboxState.Open &&
        (item.kind === InboxKind.Question || item.kind === InboxKind.Permission) &&
        item.targets.some((target) => runs.has(target.workstreamId)),
    )
    .map((item) => item.createdAt);
}

/**
 * The pass's own menu: Merge to the branch it came from, offered only where the pass lands at its
 * close (no GitHub remote, or local delivery; elsewhere its pull request merging ends it), and
 * Discard, each enabled by where the pass is.
 */
export function PassMenu({
  view,
  onClose,
  onAbandon,
}: PassActions & { readonly view: PassViewDto }) {
  const state = view.pass.state;
  const open = state === PassState.Open;
  const mergeTo = useMergeTo(view);
  // Discard (the daemon's Abandon) goes on from a close, and from an Abandon that stalled, which the daemon picks up where it
  // stopped.
  const abandonable = open || state === PassState.Closing || state === PassState.Abandoning;
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" aria-label="More actions">
          <IconDots size={16} stroke={1.5} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {onClose && mergeTo !== null ? (
          <MenuAction
            label={`Merge to ${mergeTo}`}
            byline="Land the committed pages there and end the pass."
            disabled={!open}
            onClick={onClose}
          />
        ) : null}
        <MenuAction
          label="Discard Pass"
          byline="The whole pass ends: every page not committed has its changes deleted."
          color="red"
          disabled={!abandonable}
          onClick={onAbandon}
        />
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * The pass's line in the title row (the project, the pass and its counts) with its actions: Open Pull
 * Request once a page is signed off, and a menu with Merge to its branch (where it lands at its close) and Discard. Under the row, at the top
 * of the content: why Open Pull Request is missing, the close's progress, and the timing hint, dimmed,
 * when it has something to say. While the pass closes its page actions wait and Abandon stays. While the
 * frame draws the panel, the line, the pull request and the menu are the panel's head (the workspace draws
 * them) and the title row names the shown page, so only the close's progress and the hint remain here; a pass
 * with no page has none to name, so the row keeps the line.
 */
export function PassHeader(props: PassHeaderProps) {
  const { project, view, inbox, now, pullRequest } = props;
  const { panelShown } = useFrameSlots();
  const menuActions: PassActions = {
    ...(props.onClose === undefined ? {} : { onClose: props.onClose }),
    onAbandon: props.onAbandon,
  };
  const clock = { now, medianTurnMinutes: medianTurnMinutes(view.turns) };
  const statuses = view.pages.map((page) => pageStatus(page, inbox, clock, view).status);
  const hint = timingLine({
    turns: view.turns,
    pages: view.pages.map((page, n) => ({
      status: statuses[n] ?? PageStatus.NotStarted,
      readyAt: page.turn?.readyAt ?? null,
    })),
    asking: askingSince(view, inbox),
    now,
  });
  const signedOff = statuses.includes(PageStatus.SignedOff);
  return (
    <Stack gap={4}>
      {panelShown && view.pages.length > 0 ? null : (
        <>
          <TitleRow
            lines={2}
            title={headerLine(project.name, passTitle(view.pages, view.pass.name), statuses)}
            actions={
              <>
                {signedOff ? pullRequest : null}
                <PassMenu view={view} {...menuActions} />
              </>
            }
          />
        </>
      )}
      <CloseProgress
        state={view.pass.state}
        step={view.closeStep}
        facts={{
          delivery: project.delivery,
          gated: project.gateCommand !== null,
          takingOut: view.pages.some((page) => page.signOff !== PassSignOff.Done),
          stopped: view.notices.some((notice) => notice.kind === PassNoticeKind.Close),
        }}
      />
      {hint === null ? null : (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Stack>
  );
}

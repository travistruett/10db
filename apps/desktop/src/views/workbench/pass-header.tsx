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
import { ActionIcon, Button, Group, Menu, Stack, Text, Title } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { CloseProgress } from './close-progress';
import { PageStatus, pageStatus } from './page-status';
import { medianTurnMinutes, timingLine } from './timing';

// Workbench spec §4.3: the pass header holds the pass's own actions; a page's actions stay at its
// composer, so the two never share a bar.

/** What the header counts, in its order, and the statuses each count takes in. */
const COUNTS: readonly { readonly words: string; readonly of: readonly PageStatus[] }[] = [
  { words: 'signed off', of: [PageStatus.SignedOff] },
  { words: 'signing off', of: [PageStatus.SigningOff, PageStatus.Waiting] },
  { words: 'ready', of: [PageStatus.Ready] },
  { words: 'asking', of: [PageStatus.Asks] },
  { words: 'failed', of: [PageStatus.Failed] },
  { words: 'working', of: [PageStatus.Working, PageStatus.Paused] },
];

/** "ampsio · Settings pass · 2 signed off · 1 ready": zero counts and pages not started left out. */
export function headerLine(project: string, pass: string, statuses: readonly PageStatus[]): string {
  const counts = COUNTS.flatMap(({ words, of }) => {
    const count = statuses.filter((status) => of.includes(status)).length;
    return count === 0 ? [] : [`${String(count)} ${words}`];
  });
  return [project, pass, ...counts].join(' · ');
}

export interface PassHeaderProps {
  readonly project: ProjectViewDto;
  readonly view: PassViewDto;
  /** The open Inbox items: a page's question or permission targets its run. */
  readonly inbox: readonly InboxItemDto[];
  /** Now, in epoch milliseconds. */
  readonly now: number;
  readonly onAddPage: () => void;
  /** Open Pull Request, shown once a page is signed off; without it there is none. */
  readonly pullRequest?: ReactNode;
  /** Without it there is no Close Pass…. */
  readonly onClose?: () => void;
  readonly onRename: () => void;
  readonly onAbandon: () => void;
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
 * One line with the project, the pass and its counts; Add Page, Open Pull Request once a page is
 * signed off, and a menu with Close Pass…, Rename and Abandon Pass…; the timing hint, dimmed, when it
 * has something to say. While the pass closes its page actions wait and Abandon stays.
 */
export function PassHeader(props: PassHeaderProps) {
  const { project, view, inbox, now, onAddPage, pullRequest, onClose, onRename, onAbandon } = props;
  const clock = { now, medianTurnMinutes: medianTurnMinutes(view.turns) };
  const statuses = view.pages.map((page) => pageStatus(page, inbox, clock, view.pages).status);
  const open = view.pass.state === PassState.Open;
  // Abandon goes on from a close, and from an Abandon that stalled, which the daemon picks up where it
  // stopped.
  const abandonable =
    open || view.pass.state === PassState.Closing || view.pass.state === PassState.Abandoning;
  const hint = timingLine({
    turns: view.turns,
    pages: view.pages.map((page, n) => ({
      status: statuses[n] ?? PageStatus.NotStarted,
      readyAt: page.turn?.readyAt ?? null,
    })),
    asking: askingSince(view, inbox),
    now,
  });
  return (
    <Stack gap={4}>
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Title order={2} size="h5" fw={500} lineClamp={1} style={{ minWidth: 0 }}>
          {headerLine(project.name, view.pass.name, statuses)}
        </Title>
        <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
          <Button variant="default" size="xs" disabled={!open} onClick={onAddPage}>
            Add Page
          </Button>
          {statuses.includes(PageStatus.SignedOff) ? pullRequest : null}
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label="More pass actions">
                <IconDots size={16} stroke={1.5} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {onClose ? (
                <Menu.Item disabled={!open} onClick={onClose}>
                  Close Pass…
                </Menu.Item>
              ) : null}
              <Menu.Item disabled={!open} onClick={onRename}>
                Rename
              </Menu.Item>
              <Menu.Item color="red" disabled={!abandonable} onClick={onAbandon}>
                Abandon Pass…
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
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

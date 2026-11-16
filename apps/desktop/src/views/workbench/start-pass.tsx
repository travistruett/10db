import {
  pageLabel,
  type GoalId,
  type PageRow,
  type PassOpenRequest,
  type PassStartDto,
  type ProjectViewDto,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { Button, Code, Group, Stack, Text } from '@mantine/core';
import { Fragment, useState, type ReactNode } from 'react';
import { PageList } from './page-list';
import { StartLines } from './start-lines';
import { joinableTasks, openRequest, tickedWords, type PickTicks } from './start-pass-rules';

export interface StartPassProps {
  readonly project: ProjectViewDto;
  readonly start: PassStartDto;
  /** The project's tasks; the open ones that work on a page are offered. */
  readonly tasks: readonly TaskDto[];
  /** What a link ticks: the Board's Work on These, or the pages of Factory's Work on This. */
  readonly initial: { readonly pages: readonly string[]; readonly taskIds: readonly TaskId[] };
  /** The goal the new pages join, from Factory's Work on This. */
  readonly goalId: GoalId | null;
  /** Now, in epoch milliseconds. */
  readonly now: number;
  readonly onStart: (request: PassOpenRequest) => void;
  readonly starting: boolean;
  /** Why the daemon refused the last Start Pass; said beside the button. */
  readonly error: string | null;
  /** What the setup found, and how to open it; null when there is no setup to open. */
  readonly setUp?: {
    /** The pages the repository has that the project lacks and the builder has not left out. */
    readonly newPages: readonly PageRow[];
    readonly onOpen: () => void;
  } | null;
}

/** How many found pages the line names; the rest are counted. */
const FOUND_PAGES_SHOWN = 3;

/** "Sessions /sessions found in code", or the first few of several and a count of the rest. */
function foundPagesLine(pages: readonly PageRow[]): ReactNode {
  const shown = pages.slice(0, FOUND_PAGES_SHOWN).map((page, i) => (
    <Fragment key={page.name}>
      {i === 0 ? '' : ', '}
      {pageLabel(page)}
      {page.route === undefined ? null : (
        <>
          {' '}
          <Code>{page.route}</Code>
        </>
      )}
    </Fragment>
  ));
  const more = pages.length - FOUND_PAGES_SHOWN;
  return (
    <>
      {shown}
      {more > 0 ? ` and ${String(more)} more` : null} found in code
    </>
  );
}

/**
 * The Workbench with no pass open (spec §4.2): the project's pages and open UI tasks to tick, then
 * Start Pass with what is ticked beside it.
 */
export function StartPass(props: StartPassProps) {
  const { project, start, tasks, initial, goalId, now, onStart, starting, error, setUp } = props;
  const joinable = joinableTasks(tasks, project.areas);
  const [ticks, setTicks] = useState<PickTicks>(() => ({
    pages: initial.pages.filter((page) => start.pages.some((p) => p.area === page)),
    tasks: joinable.filter((task) => initial.taskIds.includes(task.taskId)),
  }));
  const count = ticks.pages.length + ticks.tasks.length;
  const refusal = error ?? start.refusal?.message ?? null;
  return (
    <Stack gap="lg">
      <PageList
        pages={start.pages}
        tasks={joinable}
        areas={project.areas}
        ticks={ticks}
        onTicks={setTicks}
        now={now}
      />
      {setUp == null || setUp.newPages.length === 0 ? null : (
        <Group gap="xs" role="status">
          <Text size="sm" c="dimmed">
            {foundPagesLine(setUp.newPages)}
            {' · '}
          </Text>
          <Button variant="subtle" size="compact-sm" px={0} onClick={setUp.onOpen}>
            Review
          </Button>
        </Group>
      )}
      <Group justify="space-between" align="flex-end" gap="lg" wrap="nowrap" data-start-bar>
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <StartLines ticks={ticks} start={start} project={project} />
          {refusal === null ? null : (
            <Text size="sm" c="red" role="alert">
              {refusal}
            </Text>
          )}
        </Stack>
        <Group gap="md" wrap="nowrap" style={{ flexShrink: 0 }}>
          <Text size="sm" c="dimmed">
            {tickedWords(ticks)}
          </Text>
          <Button
            // The daemon would refuse to open now, for the reason beside the button.
            disabled={count === 0 || start.refusal !== null}
            loading={starting}
            onClick={() => {
              onStart(openRequest(ticks, goalId, project.areas));
            }}
          >
            Start Pass
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

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
import { Button, Code, Group, Stack, Text, Textarea } from '@mantine/core';
import { Fragment, useState, type ReactNode } from 'react';
import { CountBadge } from '../../shell/count-badge';
import { PagePicker } from './page-picker';
import { StartLines } from './start-lines';
import { joinableTasks, openRequest, type PickTicks } from './start-pass-rules';

/** How many new pages the line names; the rest are counted. */
const NEW_PAGES_SHOWN = 3;

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
  /** The setup's suggestions still to look at, and how to open them; null when there are none. */
  readonly setUp?: {
    readonly count: number;
    /** The pages the repository has that the project lacks and the builder has not left out. */
    readonly newPages: readonly PageRow[];
    readonly onOpen: () => void;
  } | null;
}

/** "New page found: Sessions /sessions", or the count and the first few of several. */
function newPagesLine(pages: readonly PageRow[]): ReactNode {
  const shown = pages.slice(0, NEW_PAGES_SHOWN).map((page, i) => (
    <Fragment key={page.name}>
      {i === 0 ? ' ' : ', '}
      {pageLabel(page)}
      {page.route === undefined ? null : (
        <>
          {' '}
          <Code>{page.route}</Code>
        </>
      )}
    </Fragment>
  ));
  const more = pages.length - NEW_PAGES_SHOWN;
  return pages.length === 1 ? (
    <>New page found:{shown}</>
  ) : (
    <>
      {`${String(pages.length)} new pages found:`}
      {shown}
      {more > 0 ? ` and ${String(more)} more` : null}
    </>
  );
}

/**
 * The Workbench with no pass open (spec §4.2): its purpose, the pages and open UI tasks to tick, what
 * is bothering the builder, and Start Pass.
 */
export function StartPass(props: StartPassProps) {
  const { project, start, tasks, initial, goalId, now, onStart, starting, error, setUp } = props;
  const joinable = joinableTasks(tasks, project.areas);
  const [ticks, setTicks] = useState<PickTicks>(() => ({
    pages: initial.pages.filter((page) => start.pages.some((p) => p.area === page)),
    tasks: joinable.filter((task) => initial.taskIds.includes(task.taskId)),
  }));
  const [bothering, setBothering] = useState('');
  const count = ticks.pages.length + ticks.tasks.length;
  const refusal = error ?? start.refusal?.message ?? null;
  return (
    <Stack gap="lg">
      <Group justify="space-between" gap="sm">
        <Text>Work through pages with the agents, live.</Text>
        {setUp == null ? null : (
          <Button
            variant="default"
            size="xs"
            rightSection={setUp.count === 0 ? null : <CountBadge count={setUp.count} />}
            onClick={setUp.onOpen}
          >
            Set Up
          </Button>
        )}
      </Group>
      <PagePicker
        pages={start.pages}
        tasks={joinable}
        areas={project.areas}
        ticks={ticks}
        onTicks={setTicks}
        now={now}
      />
      {setUp == null || setUp.newPages.length === 0 ? null : (
        <Group gap="sm" wrap="nowrap" justify="space-between" role="status">
          <Text size="sm">{newPagesLine(setUp.newPages)}</Text>
          <Button variant="default" size="xs" onClick={setUp.onOpen}>
            Set Up
          </Button>
        </Group>
      )}
      <Textarea
        label="What's bothering you?"
        description="Sent to every new page as its first message. Left empty, each page waits for yours."
        autosize
        minRows={1}
        maxRows={6}
        value={bothering}
        onChange={(event) => {
          setBothering(event.currentTarget.value);
        }}
      />
      <Group justify="space-between" align="flex-end" gap="lg" wrap="nowrap" mt="xl" data-start-bar>
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <StartLines ticks={ticks} start={start} project={project} />
          {refusal === null ? null : (
            <Text size="sm" c="red" role="alert">
              {refusal}
            </Text>
          )}
        </Stack>
        <Button
          // The daemon would refuse to open now, for the reason beside the button.
          disabled={count === 0 || start.refusal !== null}
          loading={starting}
          onClick={() => {
            onStart(openRequest(ticks, bothering, goalId, project.areas));
          }}
        >
          Start
        </Button>
      </Group>
    </Stack>
  );
}

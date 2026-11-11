import type {
  GoalId,
  PassOpenRequest,
  PassStartDto,
  ProjectViewDto,
  TaskDto,
  TaskId,
} from '@10db/contracts';
import { Anchor, Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';
import { PagePicker } from './page-picker';
import { StartLines } from './start-lines';
import { joinableTasks, openRequest, type PickTicks } from './start-pass-rules';

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
  readonly setUp?: { readonly count: number; readonly onOpen: () => void } | null;
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
    <Stack gap="lg" maw={640}>
      <Group justify="space-between" gap="sm">
        <Text>Work through pages with the agents, live.</Text>
        {setUp == null ? null : (
          <Anchor component="button" type="button" size="sm" onClick={setUp.onOpen}>
            {`Set Up (${String(setUp.count)})`}
          </Anchor>
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
      <StartLines ticks={ticks} start={start} project={project} />
      <Group justify="flex-end" gap="sm" wrap="nowrap" mt="xl" data-start-bar>
        {refusal === null ? null : (
          <Text size="sm" c="red" role="alert">
            {refusal}
          </Text>
        )}
        <Button
          // The daemon would refuse to open now, for the reason beside the button.
          disabled={count === 0 || start.refusal !== null}
          loading={starting}
          onClick={() => {
            onStart(openRequest(ticks, bothering, goalId));
          }}
        >
          {`Start Pass (${String(count)})`}
        </Button>
      </Group>
    </Stack>
  );
}

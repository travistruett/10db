import type { QuestionMeasureDto, SizingMeasureDto } from '@10db/contracts';
import { Group, Stack, Text } from '@mantine/core';
import { useShapeMeasures } from '../../daemon/shape-measures-queries';

const percent = (part: number, whole: number): string =>
  `${String(Math.round((part / whole) * 100))}%`;

/** Settings › Decisions › Sizing (spec §8 Calibration). */
function SizingRow({ sizing }: { readonly sizing: SizingMeasureDto }) {
  const buckets = (['S', 'M', 'L', 'XL'] as const)
    .filter((b) => sizing.buckets[b].n > 0)
    .map((b) => `${b} ${String(sizing.buckets[b].within)} of ${String(sizing.buckets[b].n)}`);
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        Sizing
      </Text>
      <Text size="xs" c="dimmed">
        Finished tasks Plan converted, whose size was within one bucket of the lane time they took.
      </Text>
      <Stack gap={2} role="group" aria-label="Sizing">
        {sizing.n === 0 ? (
          <Text size="sm" c="dimmed">
            No converted task has finished yet
          </Text>
        ) : (
          <>
            <Text size="sm">
              {percent(sizing.within, sizing.n)} within one bucket ({String(sizing.within)} of{' '}
              {String(sizing.n)})
            </Text>
            <Text size="xs" c="dimmed">
              {buckets.join(' · ')}
            </Text>
          </>
        )}
        {sizing.overrides > 0 ? (
          <Text size="xs" c="dimmed">
            {String(sizing.overrides)} set by you, not counted
          </Text>
        ) : null}
      </Stack>
    </Stack>
  );
}

const taskCount = (n: number): string => `${String(n)} ${n === 1 ? 'task' : 'tasks'}`;

const perTask = (rate: QuestionMeasureDto['converted']): string =>
  `${String(Math.round((rate.cards / rate.tasks) * 100) / 100)} question cards per task (${taskCount(rate.tasks)})`;

/** Settings › Decisions › Questions (spec §7 Measure): Inbox question cards, converted against other tasks. */
function QuestionsRow({ questions }: { readonly questions: QuestionMeasureDto }) {
  const { converted, other } = questions;
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        Questions
      </Text>
      <Text size="xs" c="dimmed">
        Inbox question cards on tasks Plan converted, against the project's other tasks. Only tasks
        that started count.
      </Text>
      <Stack gap={2} role="group" aria-label="Questions">
        {converted.tasks === 0 ? (
          <Text size="sm" c="dimmed">
            No converted task has started yet
          </Text>
        ) : (
          <Text size="sm">{perTask(converted)} converted</Text>
        )}
        {other.tasks === 0 ? null : (
          <Text size="xs" c="dimmed">
            {perTask(other)} for the project&apos;s other tasks
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

/** How Plan is doing across every project: the Sizing hit rate and the question cards per task. Nothing until read. */
export function PlanMeasures() {
  const measures = useShapeMeasures();
  if (measures.data === undefined) return null;
  return (
    <Stack component="section" aria-label="How Plan is doing" gap="sm">
      <Group gap="xs" align="baseline">
        <Text component="h3" fw={600} size="sm" m={0}>
          How Plan is doing
        </Text>
        <Text size="xs" c="dimmed">
          All projects
        </Text>
      </Group>
      <SizingRow sizing={measures.data.sizing} />
      <QuestionsRow questions={measures.data.questions} />
    </Stack>
  );
}

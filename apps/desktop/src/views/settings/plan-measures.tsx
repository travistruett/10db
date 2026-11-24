import type { QuestionMeasureDto, SizingMeasureDto } from '@10db/contracts';
import { Group, Stack, Text, Title } from '@mantine/core';
import { useShapeMeasures } from '../../daemon/shape-measures-queries';

const percent = (part: number, whole: number): string =>
  `${String(Math.round((part / whole) * 100))}%`;

/** Sizing: how often a converted task's size was within one bucket of the lane time it took (spec §8 Calibration). */
function SizingRow({ sizing }: { readonly sizing: SizingMeasureDto }) {
  const buckets = (['S', 'M', 'L', 'XL'] as const)
    .filter((b) => sizing.buckets[b].n > 0)
    .map((b) => `${b} ${String(sizing.buckets[b].within)} of ${String(sizing.buckets[b].n)}`);
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        Sizes
      </Text>
      <Text size="xs" c="dimmed">
        How often the size Plan gave a task (S to XL) matched the time it took, give or take one
        size.
      </Text>
      <Stack gap={2} role="group" aria-label="Sizing">
        {sizing.n === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing yet: no task from Plan has finished.
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

/** Questions (spec §7 Measure): Inbox question cards, converted against other tasks. */
function QuestionsRow({ questions }: { readonly questions: QuestionMeasureDto }) {
  const { converted, other } = questions;
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        Questions
      </Text>
      <Text size="xs" c="dimmed">
        How many questions a task from Plan sent to your Inbox, against tasks written by hand.
      </Text>
      <Stack gap={2} role="group" aria-label="Questions">
        {converted.tasks === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing yet: no task from Plan has started.
          </Text>
        ) : (
          <Text size="sm">{perTask(converted)} from Plan</Text>
        )}
        {other.tasks === 0 ? null : (
          <Text size="xs" c="dimmed">
            {perTask(other)} written by hand
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

/** Whether tasks made in Plan turn out well, across every project: their sizes and the questions they send. */
export function PlanMeasures() {
  const measures = useShapeMeasures();
  if (measures.data === undefined) return null;
  return (
    <Stack component="section" aria-label="Plan's Track Record" gap="sm">
      <Group gap="xs" align="baseline">
        <Title order={4}>Plan&apos;s Track Record</Title>
      </Group>
      <Text size="xs" c="dimmed" mt={-8}>
        How the tasks Plan made turned out, across every project.
      </Text>
      <SizingRow sizing={measures.data.sizing} />
      <QuestionsRow questions={measures.data.questions} />
    </Stack>
  );
}

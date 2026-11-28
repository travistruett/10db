import { JudgeDecision, JudgeOutcome } from '@10db/contracts';
import { Box, Group, Slider, Stack, Text } from '@mantine/core';
import { PageGuide, STILL_SURFACE, type PageGuideHandle } from '../../shell/page-guide';
import { DECISIONS } from './decision-catalogue';
import { answerText, DecisionStatus, outcomeText } from './decision-numbers';
import { StatusMark } from './decisions-table';

export const DECISIONS_GUIDE = 'How decisions work';

// Stills of the page, drawn with its own badge, slider and words: a decision's row, its Sure Enough floor and the
// Recent rows it leaves. Nothing in them is live.

const DECISION = JudgeDecision.TaskRigor;
const MODEL = 'Jev';
const FLOOR = 80;

/** A row of Every Decision: the decision, its status, its model and its floor. */
function DecisionRowPicture() {
  return (
    <Group gap="sm" wrap="nowrap" px={10} py={8} style={STILL_SURFACE}>
      <Text size="xs" fw={500} truncate style={{ flex: 1, minWidth: 0 }}>
        {DECISIONS[DECISION].label}
      </Text>
      <StatusMark text={DecisionStatus.Acting} keyed />
      <Text size="xs" c="dimmed" style={{ flex: 'none' }}>
        {MODEL}
      </Text>
      <Text size="xs" c="dimmed" style={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
        {`${String(FLOOR)}%`}
      </Text>
    </Group>
  );
}

/** Two answers either side of the floor. */
function Answer({ sure, acts }: { readonly sure: number; readonly acts: boolean }) {
  return (
    <Group gap={8} wrap="nowrap">
      <Text
        size="xs"
        fw={600}
        w={32}
        c={acts ? 'teal' : 'dimmed'}
        style={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}
      >
        {`${String(sure)}%`}
      </Text>
      <Text size="xs" {...(acts ? {} : { c: 'dimmed' })}>
        {acts ? 'The model’s answer is used' : '10db’s rules decide instead'}
      </Text>
    </Group>
  );
}

/** The drawer's Sure Enough slider at its floor, and what an answer above and below it does. */
function SureEnoughPicture() {
  return (
    <Stack gap={10} p={10} style={STILL_SURFACE}>
      <Box px={4}>
        <Slider
          min={50}
          max={99}
          value={FLOOR}
          size="sm"
          label={null}
          marks={[{ value: FLOOR, label: `${String(FLOOR)}%` }]}
          styles={{ markLabel: { fontSize: 10 } }}
          tabIndex={-1}
        />
      </Box>
      <Stack gap={4} pt={8}>
        <Answer sure={92} acts />
        <Answer sure={64} acts={false} />
      </Stack>
    </Stack>
  );
}

/** Two rows of Recent: what the model answered, how sure, and what 10db did with it. */
function RecentPicture() {
  const rows = [
    { answer: 'standard', confidence: 0.92, outcome: JudgeOutcome.Acted },
    { answer: 'careful', confidence: 0.64, outcome: JudgeOutcome.BelowFloor },
  ] as const;
  return (
    <Stack gap={0} style={STILL_SURFACE}>
      {rows.map((row, index) => (
        <Stack
          key={row.answer}
          gap={2}
          px={10}
          py={6}
          style={index === 0 ? {} : { borderTop: STILL_SURFACE.border }}
        >
          <Group gap={8} wrap="nowrap">
            <Text size="xs" fw={500} style={{ flex: 'none' }}>
              {answerText(row)}
            </Text>
            <Text fz={11} c="dimmed" truncate>
              {MODEL}
            </Text>
          </Group>
          <Text fz={11} truncate {...(row.outcome === JudgeOutcome.Acted ? {} : { c: 'dimmed' })}>
            {outcomeText({
              decision: DECISION,
              outcome: row.outcome,
              answer: row.answer,
              model: MODEL,
              precedentId: null,
            })}
          </Text>
        </Stack>
      ))}
    </Stack>
  );
}

/** How decisions work: a model makes the small calls when it is sure enough, and 10db's rules make the rest. */
export function DecisionsGuide({ guide }: { readonly guide: PageGuideHandle }) {
  return (
    <PageGuide
      guide={guide}
      lead="Many times a day 10db makes a small call, such as how much process a task needs. A model can make each one, or 10db's own rules can."
      steps={[
        {
          title: 'Each call is a decision',
          caption: 'Each has its own switch and model. Off, the rules make it.',
          picture: <DecisionRowPicture />,
        },
        {
          title: 'Sure enough, or the rules',
          caption: 'The model acts only above its floor. Below it, the rules decide.',
          picture: <SureEnoughPicture />,
        },
        {
          title: 'Recent shows each call',
          caption: 'What the model answered, how sure it was, and what 10db did.',
          picture: <RecentPicture />,
        },
      ]}
      scope="Decisions apply in every project, on the account you pick. Ones you record yourself are in Knowledge."
    />
  );
}

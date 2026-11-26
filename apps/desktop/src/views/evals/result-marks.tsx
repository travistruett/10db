import { Box, Group, Text } from '@mantine/core';
import type { EvalModelResultDto, EvalTrendPointDto } from '@10db/contracts';
import { gatesPassed, rateText, unansweredText, worstGate } from './eval-figures';

/** A run's result as a dot: filled green for passed, a red ring for failed. The words beside carry it. */
function ResultDot({ passed }: { readonly passed: boolean }) {
  return (
    <Box
      component="span"
      aria-hidden
      w={8}
      h={8}
      style={{
        display: 'inline-block',
        flex: 'none',
        borderRadius: '50%',
        ...(passed
          ? { background: 'var(--mantine-color-green-filled)' }
          : { boxShadow: 'inset 0 0 0 1.5px var(--mantine-color-red-filled)' }),
      }}
    />
  );
}

/** A thin rule before a run that graded a different eval than the run before it. */
function EvalChange() {
  return (
    <Box
      component="span"
      aria-hidden
      w={1}
      h={12}
      style={{ display: 'inline-block', flex: 'none', background: 'var(--mantine-color-dimmed)' }}
    />
  );
}

/**
 * The last runs, oldest first, as a row of dots, with a rule where the eval itself changed, so a dot is
 * read against the runs that graded the same eval. Its name says the same in words.
 */
export function Trend({ runs }: { readonly runs: readonly EvalTrendPointDto[] }) {
  if (runs.length === 0) return null;
  const failed = runs.filter((run) => !run.passed).length;
  const changes = runs.filter((run) => run.evalChanged).length;
  return (
    <Group
      gap={4}
      wrap="nowrap"
      role="img"
      aria-label={`Last ${String(runs.length)} runs: ${String(failed)} failed${
        changes > 0 ? `, the eval changed ${String(changes)} times` : ''
      }`}
    >
      {runs.map((run, place) => (
        <Group key={`${String(place)}-${String(run.passed)}`} gap={4} wrap="nowrap">
          {run.evalChanged ? <EvalChange /> : null}
          <ResultDot passed={run.passed} />
        </Group>
      ))}
    </Group>
  );
}

/** The project's name for a binding, when it says more than the model it names (`SMART@medium`). */
function slotText(result: EvalModelResultDto): string | null {
  if (result.slot === null || result.slot.startsWith(result.model)) return null;
  return result.slot;
}

/** One model's line in a run: its result, the model, and the gate that failed it. */
export function ModelLine({ result }: { readonly result: EvalModelResultDto }) {
  const worst = worstGate(result);
  const slot = slotText(result);
  const unanswered = unansweredText(result.unanswered);
  return (
    <Group gap={8} wrap="nowrap" align="baseline">
      <ResultDot passed={result.passed} />
      <Group gap={2} style={{ columnGap: 8, minWidth: 0 }} align="baseline">
        <Text size="sm" c="var(--mantine-color-bright)" style={{ whiteSpace: 'nowrap' }}>
          {result.model}
        </Text>
        <Text size="xs" c={result.passed ? 'dimmed' : 'red'}>
          {`${gatesPassed(result)} gates`}
          {worst === null
            ? ''
            : ` · ${worst.name} ${rateText(worst.rate)}${worst.minimum === null ? '' : ` < ${rateText(worst.minimum)}`}`}
          {unanswered === null ? null : <Text span size="xs" c="dimmed">{` · ${unanswered}`}</Text>}
          {slot === null ? null : <Text span size="xs" c="dimmed">{` · ${slot}`}</Text>}
        </Text>
      </Group>
    </Group>
  );
}

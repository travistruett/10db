import { Box, Group, Text } from '@mantine/core';
import type { EvalModelResultDto } from '@10db/contracts';
import { gatesPassed, rateText, worstGate } from './eval-figures';

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

/** The last runs, oldest first, as a row of dots; its name says the same in words. */
export function Trend({ runs }: { readonly runs: readonly boolean[] }) {
  if (runs.length === 0) return null;
  const failed = runs.filter((passed) => !passed).length;
  return (
    <Group
      gap={4}
      wrap="nowrap"
      role="img"
      aria-label={`Last ${String(runs.length)} runs: ${String(failed)} failed`}
    >
      {runs.map((passed, place) => (
        <ResultDot key={`${String(place)}-${String(passed)}`} passed={passed} />
      ))}
    </Group>
  );
}

/** One model's line in a run: its result, the model, and the gate that failed it. */
export function ModelLine({ result }: { readonly result: EvalModelResultDto }) {
  const worst = worstGate(result);
  return (
    <Group gap={8} wrap="nowrap" align="baseline">
      <ResultDot passed={result.passed} />
      <Text size="sm" c="var(--mantine-color-bright)" style={{ whiteSpace: 'nowrap' }}>
        {result.model}
      </Text>
      <Text size="xs" c={result.passed ? 'dimmed' : 'red'} style={{ whiteSpace: 'nowrap' }}>
        {`${gatesPassed(result)} gates`}
        {worst === null
          ? ''
          : ` · ${worst.name} ${rateText(worst.rate)} < ${rateText(worst.minimum ?? 1)}`}
      </Text>
      {result.slot === null ? null : (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {result.slot}
        </Text>
      )}
    </Group>
  );
}

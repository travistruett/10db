import type { DecisionStatsDto, JudgeDecision } from '@10db/contracts';
import { Slider, Stack, Text } from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { useRef, useState } from 'react';
import { usePatchJudge } from '../../daemon/judge-queries';
import { DECISIONS } from './decision-catalogue';
import { DaemonRequestError } from '../../daemon/client';
import { previewText, thresholdPreview } from './decision-numbers';

const MIN_PERCENT = 50;
const MAX_PERCENT = 99;
/** Holding an arrow key moves the slider many times; one save follows the last move. */
const SAVE_DELAY_MS = 600;

const drawnPercent = (floor: number): number =>
  Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(floor * 100)));

/**
 * How sure a model must be before 10db acts on its answer, from 50% to 99%, with what that would have done to
 * the last 30 days of answers. The slider keeps the builder's edit until it is saved, so a save coming back
 * never moves it under a key; a floor saved outside the range is drawn at the nearest end and said in words.
 */
export function SureEnough({
  decision,
  floor,
  answers,
  loading = false,
  model,
  disabled,
}: {
  readonly decision: JudgeDecision;
  readonly floor: number;
  /** The last 30 days' answers; undefined when they could not be read. */
  readonly answers: DecisionStatsDto['answers'] | undefined;
  /** The answers are still being read: the preview says nothing yet. */
  readonly loading?: boolean;
  readonly model: string;
  readonly disabled: boolean;
}) {
  const patch = usePatchJudge();
  const [edit, setEdit] = useState<number | null>(null);
  const saved = drawnPercent(floor);
  const shown = edit ?? saved;
  // The value drawn before the edit began, and the latest edit waiting to be saved.
  const pending = useRef<{ readonly from: number; value: number } | null>(null);
  const save = useDebouncedCallback(
    () => {
      const waiting = pending.current;
      pending.current = null;
      if (waiting === null) return;
      const { from, value } = waiting;
      if (value === from) {
        setEdit(null);
        return;
      }
      patch.mutate(
        { decisions: { [decision]: { floor: value / 100 } } },
        {
          // A newer edit stays drawn; only the one just saved gives way to the saved value.
          onSettled: () => {
            setEdit((current) => (current === value ? null : current));
          },
        },
      );
    },
    { delay: SAVE_DELAY_MS, flushOnUnmount: true },
  );
  const previewPercent = edit ?? Math.round(floor * 100);
  const outside = floor < MIN_PERCENT / 100 || floor > MAX_PERCENT / 100;
  return (
    <Stack gap={4}>
      <Slider
        thumbLabel="Sure enough"
        min={MIN_PERCENT}
        max={MAX_PERCENT}
        step={1}
        label={(v) => `${String(v)}%`}
        value={shown}
        disabled={disabled}
        onChange={(value) => {
          if (pending.current === null) pending.current = { from: shown, value };
          else pending.current.value = value;
          setEdit(value);
          save();
        }}
        onBlur={() => {
          save.flush();
        }}
      />
      {loading ? null : (
        <Text size="xs" c="dimmed">
          {answers === undefined
            ? 'Your recent answers could not be read.'
            : previewText(
                // A floor saved outside the range is previewed as saved until it is moved.
                previewPercent,
                thresholdPreview(answers, previewPercent / 100, model),
                DECISIONS[decision].mode,
              )}
        </Text>
      )}
      {patch.isError ? (
        <Text size="xs" c="red" role="alert">
          {patch.error instanceof DaemonRequestError
            ? patch.error.message
            : "Couldn't reach the daemon."}
        </Text>
      ) : null}
      {outside && edit === null ? (
        <Text size="xs" c="dimmed">
          Saved at {String(Math.round(floor * 100))}%.
        </Text>
      ) : null}
    </Stack>
  );
}

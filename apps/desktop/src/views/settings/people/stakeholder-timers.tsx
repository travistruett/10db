import type { StakeholderTimersDto } from '@10db/contracts';
import { Alert, Group, Loader, NumberInput, Stack, Switch, Text } from '@mantine/core';
import { useState } from 'react';
import { useSetStakeholderTimers, useStakeholderTimers } from '../../../daemon/people';
import { SettingRow, SettingsCard } from '../setting-row';

const DEFAULT_REMIND_HOURS = 4;

function Hours() {
  return (
    <Text size="sm" c="dimmed" aria-hidden>
      hours
    </Text>
  );
}

/** When 10db reminds a recipient and when it returns a question to the builder; both in real hours. */
export function StakeholderTimers() {
  const timers = useStakeholderTimers();
  const save = useSetStakeholderTimers();
  // The text typed in a field, until it is saved or abandoned.
  const [typed, setTyped] = useState<{ remind?: number; back?: number }>({});
  if (timers.isPending) return <Loader size="sm" />;
  if (timers.isError)
    return (
      <Alert color="red" title="Couldn't load the timers">
        {timers.error.message}
      </Alert>
    );
  const current = timers.data;
  const change = (next: StakeholderTimersDto): void => {
    save.mutate(next, {
      onSettled: () => {
        setTyped({});
      },
    });
  };
  const remind = typed.remind ?? current.remindAfterHours ?? DEFAULT_REMIND_HOURS;
  const back = typed.back ?? current.returnAfterHours;
  return (
    <Stack gap="xs">
      <SettingsCard
        title="When Someone Hasn't Answered"
        description="Hours are real time: a timer due while the Mac sleeps fires on wake."
      >
        <SettingRow
          label="Remind Them After"
          description="One reminder in their thread; off never nudges."
        >
          <Group gap="sm" justify="flex-end" wrap="nowrap">
            <Switch
              aria-label="Send a reminder"
              checked={current.remindAfterHours !== null}
              onChange={(event) => {
                change({
                  remindAfterHours: event.currentTarget.checked
                    ? Math.max(1, Math.min(DEFAULT_REMIND_HOURS, current.returnAfterHours - 1))
                    : null,
                  returnAfterHours: current.returnAfterHours,
                });
              }}
            />
            <NumberInput
              allowDecimal={false}
              aria-label="Remind after (hours)"
              w={90}
              min={1}
              max={72}
              disabled={current.remindAfterHours === null}
              value={remind}
              onChange={(value) => {
                if (typeof value === 'number') setTyped((t) => ({ ...t, remind: value }));
              }}
              onBlur={() => {
                if (typed.remind !== undefined && typed.remind !== current.remindAfterHours)
                  change({
                    remindAfterHours: typed.remind,
                    returnAfterHours: current.returnAfterHours,
                  });
              }}
            />
            <Hours />
          </Group>
        </SettingRow>
        <SettingRow
          label="Bring It Back to You After"
          description="The question returns to your Inbox."
        >
          <Group gap="sm" justify="flex-end" wrap="nowrap">
            <NumberInput
              allowDecimal={false}
              aria-label="Back to you after (hours)"
              w={90}
              min={1}
              max={168}
              value={back}
              onChange={(value) => {
                if (typeof value === 'number') setTyped((t) => ({ ...t, back: value }));
              }}
              onBlur={() => {
                if (typed.back !== undefined && typed.back !== current.returnAfterHours)
                  change({
                    remindAfterHours: current.remindAfterHours,
                    returnAfterHours: typed.back,
                  });
              }}
            />
            <Hours />
          </Group>
        </SettingRow>
      </SettingsCard>
      {save.isError ? (
        <Alert color="red" variant="light">
          {save.error.message}
        </Alert>
      ) : null}
    </Stack>
  );
}

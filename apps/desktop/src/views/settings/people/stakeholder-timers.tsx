import type { StakeholderTimersDto } from '@10db/contracts';
import { Alert, Group, Loader, NumberInput, Stack, Switch, Text } from '@mantine/core';
import { useState } from 'react';
import { useSetStakeholderTimers, useStakeholderTimers } from '../../../daemon/people';
import { SettingRow, SettingsCard } from '../setting-row';

const DEFAULT_REMIND_HOURS = 4;

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
      <SettingsCard title="Timers">
        <SettingRow
          label="Remind after"
          description="One reminder in the thread. Turn it off to never nudge."
        >
          <Group gap="sm">
            <Switch
              aria-label="Remind me"
              checked={current.remindAfterHours !== null}
              onChange={(event) => {
                change({
                  remindAfterHours: event.currentTarget.checked ? DEFAULT_REMIND_HOURS : null,
                  returnAfterHours: current.returnAfterHours,
                });
              }}
            />
            <NumberInput
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
          </Group>
        </SettingRow>
        <SettingRow
          label="Back to you after"
          description="The question returns to your Inbox when nobody has answered."
        >
          <NumberInput
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
        </SettingRow>
      </SettingsCard>
      <Text size="xs" c="dimmed">
        Measured in real time; one that comes due while your Mac sleeps fires when it wakes.
      </Text>
      {save.isError ? (
        <Alert color="red" variant="light">
          {save.error.message}
        </Alert>
      ) : null}
    </Stack>
  );
}

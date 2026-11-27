import type { StakeholderTimersDto } from '@10db/contracts';
import { Alert, Group, NumberInput, Stack, Switch, Text } from '@mantine/core';
import { useSetStakeholderTimers, useStakeholderTimers } from '../../../daemon/people';
import { SettingRow, SettingsCard } from '../setting-row';
import { SettingRowsLoading } from '../setting-rows-loading';
import { useDraft } from '../settings-drafts';

const DEFAULT_REMIND_HOURS = 4;

const CARD_TITLE = "When Someone Hasn't Answered";
const CARD_DESCRIPTION = 'Hours are real time: a timer due while the Mac sleeps fires on wake.';

function Hours() {
  return (
    <Text size="sm" c="dimmed" aria-hidden>
      hours
    </Text>
  );
}

/**
 * When 10db reminds a recipient and when it returns a question to the builder; both in real hours, saved
 * with the page's bar.
 */
export function StakeholderTimers() {
  const timers = useStakeholderTimers();
  const save = useSetStakeholderTimers();
  const draft = useDraft({
    saved: timers.data,
    save: (next: StakeholderTimersDto) => save.mutateAsync(next),
  });
  const current = draft.value;
  if (timers.isError)
    return (
      <Alert color="red" title="Couldn't load the timers">
        {timers.error.message}
      </Alert>
    );
  if (current === undefined)
    return (
      <SettingRowsLoading
        title={CARD_TITLE}
        description={CARD_DESCRIPTION}
        rows={2}
        label="Loading the timers"
      />
    );
  const remind = current.remindAfterHours ?? DEFAULT_REMIND_HOURS;
  const back = current.returnAfterHours;
  return (
    <Stack gap="xs">
      <SettingsCard title={CARD_TITLE} description={CARD_DESCRIPTION}>
        <SettingRow
          label="Remind Them After"
          description="One reminder in their thread; off never nudges."
        >
          <Group gap="sm" justify="flex-end" wrap="nowrap">
            <Switch
              aria-label="Send a reminder"
              checked={current.remindAfterHours !== null}
              onChange={(event) => {
                draft.set({
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
                if (typeof value === 'number') draft.set({ ...current, remindAfterHours: value });
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
                if (typeof value === 'number') draft.set({ ...current, returnAfterHours: value });
              }}
            />
            <Hours />
          </Group>
        </SettingRow>
      </SettingsCard>
    </Stack>
  );
}

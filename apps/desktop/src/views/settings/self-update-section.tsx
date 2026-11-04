import {
  MAX_SELF_UPDATE_WAIT_MINUTES,
  SELF_UPDATE_SWITCH,
  type SelfUpdateStatusDto,
} from '@10db/contracts';
import { Button, NumberInput, Switch, Text } from '@mantine/core';
import { useState } from 'react';
import {
  useInstallNow,
  useSelfUpdate,
  useSetSelfUpdate,
  useSetSelfUpdateWait,
} from '../../daemon/self-update-queries';
import { absoluteTime } from '../../shell/relative';
import { SettingRow, SettingsCard } from './setting-row';
import { updateWaitsFor } from './update-waits-for';

const SHORT = 7;
const short = (commit: string): string => commit.slice(0, SHORT);

/**
 * What the builder is told about an update that is available: waiting for an idle moment, or
 * draining the factory for it. Null when none waits.
 */
export function updateProgressText(data: SelfUpdateStatusDto): string | null {
  if (!data.enabled || data.availableCommit === null) return null;
  const build = short(data.availableCommit);
  const waitsFor = updateWaitsFor(data);
  if (data.draining && data.drainingSince !== null)
    return `Draining since ${absoluteTime(data.drainingSince)}: 10db is starting no new steps, sessions, gates or ships while the running steps finish, then it installs ${build} and restarts. Lanes that were queued pick up again after. ${waitsFor}`;
  const since = data.waitingSince === null ? '' : ` since ${absoluteTime(data.waitingSince)}`;
  return `${build} is waiting${since} for a moment when nothing is mid-session. If it is still waiting after ${String(data.waitMinutes)} minutes, 10db stops starting new steps until it has installed. ${waitsFor}`.trimEnd();
}

/**
 * Lets 10db install main's newest finished build by itself, when no task is mid-session. One setting
 * for the whole app, on until the builder turns it off. It follows the repository this app was built
 * from, not a project's.
 */
export function SelfUpdateSection() {
  const status = useSelfUpdate();
  const set = useSetSelfUpdate();
  const installNow = useInstallNow();
  const data = status.data;
  const running =
    data === undefined
      ? null
      : data.runningCommit === null
        ? // The blocker says it already, under the switch.
          data.blocker === null
          ? 'This app is running from source, so it never updates itself.'
          : null
        : `Running ${short(data.runningCommit)}.`;
  const blocker = data?.blocker ?? null;
  const progress = data === undefined ? null : updateProgressText(data);
  const canInstallNow =
    data !== undefined && data.enabled && data.availableCommit !== null && !data.draining;
  return (
    <SettingsCard>
      <SettingRow
        label={SELF_UPDATE_SWITCH}
        description={`When main has new commits and no task is mid-session, install its newest finished build and restart. Queued and waiting tasks carry on. It follows the repository this app was built from, whatever your projects are. ${running ?? ''}`.trim()}
      >
        <Switch
          aria-label={SELF_UPDATE_SWITCH}
          checked={data?.enabled ?? false}
          disabled={data === undefined || set.isPending}
          onChange={(event) => {
            set.mutate(event.currentTarget.checked);
          }}
        />
      </SettingRow>
      {blocker !== null ? (
        <Text
          size="sm"
          c="red"
          px="md"
          py="sm"
          role="alert"
          aria-label="Why 10db will not update itself"
        >
          {blocker.message}
        </Text>
      ) : null}
      {data !== undefined ? (
        <SettingRow
          label="Pause lanes for a waiting update"
          description="When a newer build has waited this many minutes for an idle moment, 10db stops starting new steps and lets the running ones finish, then installs and restarts. Nothing running is stopped. 0 pauses at once."
        >
          <WaitLimit key={data.waitMinutes} minutes={data.waitMinutes} />
        </SettingRow>
      ) : null}
      {progress !== null ? (
        <SettingRow
          label="Update waiting"
          description={
            <Text size="sm" c="dimmed" role="status" aria-label="Update status">
              {progress}
            </Text>
          }
        >
          {canInstallNow ? (
            <Button
              variant="default"
              loading={installNow.isPending}
              onClick={() => {
                installNow.mutate();
              }}
            >
              Install Now
            </Button>
          ) : (
            <span />
          )}
        </SettingRow>
      ) : null}
    </SettingsCard>
  );
}

function WaitLimit({ minutes }: { readonly minutes: number }) {
  const set = useSetSelfUpdateWait();
  const [value, setValue] = useState<number | string>(minutes);
  const valid =
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SELF_UPDATE_WAIT_MINUTES;
  return (
    <NumberInput
      aria-label="Minutes before lanes pause"
      min={0}
      max={MAX_SELF_UPDATE_WAIT_MINUTES}
      allowDecimal={false}
      allowNegative={false}
      clampBehavior="none"
      value={value}
      error={valid ? null : `Whole minutes, 0 to ${String(MAX_SELF_UPDATE_WAIT_MINUTES)}`}
      disabled={set.isPending}
      onChange={setValue}
      onBlur={() => {
        if (valid && value !== minutes) set.mutate(value);
      }}
    />
  );
}

import {
  MAX_SELF_UPDATE_WAIT_MINUTES,
  SELF_UPDATE_SWITCH,
  type SelfUpdateStatusDto,
} from '@10db/contracts';
import {
  ActionIcon,
  Anchor,
  Button,
  Group,
  HoverCard,
  NumberInput,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useInstallNow,
  useSelfUpdate,
  useSetSelfUpdate,
  useSetSelfUpdateWait,
} from '../../daemon/self-update-queries';
import { clockTime } from '../../shell/relative';
import { HelpText } from './help-hint';
import { SettingsSectionKey } from './sections';
import { SettingRow, SettingsCard } from './setting-row';
import { updateDeadline, updateWaitsFor } from './update-waits-for';

/** The sentence the daemon's reasons use to send the builder to GitHub's card. */
const SIGN_IN_SENTENCE = 'Settings › Integrations';

const SHORT = 7;
const short = (commit: string): string => commit.slice(0, SHORT);

/**
 * What the builder is told about an update that is available: waiting for an idle moment, or
 * draining the factory for it. Null when none waits.
 */
export function updateProgressText(data: SelfUpdateStatusDto): string | null {
  if (!data.enabled || data.availableCommit === null) return null;
  const build = short(data.availableCommit);
  if (data.notInstalling === 'failed')
    return `The update to ${build} failed, so 10db is not installing it. It tries again when main has a newer commit; to try now, turn "Update 10db by itself" off and on.`;
  if (data.notInstalling === 'rolled-back')
    return `You rolled back from ${build}, so 10db is not installing it. It installs the next finished build, once main has a newer commit; to try ${build} again now, turn "Update 10db by itself" off and on.`;
  if (data.notInstalling === 'unbuilt')
    return `${build} has no finished build yet, so there is nothing to install. 10db looks again every minute and installs it when its build finishes.`;
  if (data.notInstalling === 'fetching')
    return `10db is fetching the build of ${build}, or waiting for GitHub to finish it, which can take a few minutes. Nothing is staged yet, so there is nothing to wait for an idle moment with. 10db installs it once the build arrives and nothing is running.`;
  if (data.notInstalling === 'unreachable')
    return `Nothing is staged for ${build} and GitHub cannot be reached, so 10db is not fetching it now. 10db looks again every minute and fetches the build of ${build} once GitHub answers, then installs it when nothing is running.`;
  const waitsFor = updateWaitsFor(data);
  if (data.draining && data.drainingSince !== null)
    return `Paused new work at ${clockTime(data.drainingSince)} to install ${build}: no new steps, sessions, gates or ships start while what is running finishes, then 10db restarts with the update and queued lanes pick up again. ${waitsFor}`;
  const deadline = updateDeadline(data);
  const pause =
    deadline === null
      ? `If it waits ${String(data.waitMinutes)} minutes, 10db stops starting new steps so it can install.`
      : `If it is still waiting at ${deadline}, 10db stops starting new steps so it can install.`;
  return `${build} is ready. 10db installs it as soon as nothing is running. ${pause} ${waitsFor}`.trimEnd();
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
  const notInstalling = data?.notInstalling ?? null;
  // Unlike these, a head with no build yet takes Install Now: the daemon drains once it is staged.
  const refused = notInstalling === 'failed' || notInstalling === 'rolled-back';
  const canInstallNow =
    data !== undefined &&
    data.enabled &&
    data.availableCommit !== null &&
    !refused &&
    !data.draining;
  return (
    <SettingsCard>
      <SettingRow
        label={SELF_UPDATE_SWITCH}
        description={`Installs main's newest build when no task is mid-session. ${running ?? ''}`.trim()}
        help={
          <HelpText>
            When main has new commits and no task is mid-session, 10db installs its newest finished
            build and restarts. Queued and waiting tasks carry on. It follows the repository this
            app was built from, whatever your projects are.
          </HelpText>
        }
      >
        <Group justify="flex-end" gap="xs" wrap="nowrap">
          {blocker === null ? null : (
            <HoverCard width={300} position="bottom-end" withArrow shadow="md">
              <HoverCard.Target>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label="Why 10db will not update itself"
                >
                  <IconAlertCircle size={18} />
                </ActionIcon>
              </HoverCard.Target>
              <HoverCard.Dropdown>
                <Stack gap="xs">
                  <Text size="sm" role="alert">
                    {blocker.message}
                  </Text>
                  {blocker.message.includes(SIGN_IN_SENTENCE) ? (
                    <Anchor
                      size="sm"
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/settings/$section"
                          params={{ section: SettingsSectionKey.Integrations }}
                          search={{ focus: 'github' }}
                        />
                      )}
                    >
                      Open Integrations
                    </Anchor>
                  ) : null}
                </Stack>
              </HoverCard.Dropdown>
            </HoverCard>
          )}
          <Switch
            aria-label={SELF_UPDATE_SWITCH}
            checked={data?.enabled ?? false}
            // A blocked update can't run whatever the switch says, so the switch waits for the blocker to go.
            disabled={data === undefined || set.isPending || blocker !== null}
            onChange={(event) => {
              set.mutate(event.currentTarget.checked);
            }}
          />
        </Group>
      </SettingRow>
      {data !== undefined ? (
        <SettingRow
          label="Pause Lanes for a Waiting Update"
          description="Minutes a waiting build may wait before lanes pause."
          help={
            <HelpText>
              When a newer build has waited this many minutes for an idle moment, 10db stops
              starting new steps and lets the running ones finish, then installs and restarts.
              Nothing running is stopped. 0 pauses at once.
            </HelpText>
          }
        >
          <WaitLimit key={data.waitMinutes} minutes={data.waitMinutes} />
        </SettingRow>
      ) : null}
      {progress !== null ? (
        <SettingRow
          label={
            refused
              ? 'Update not installing'
              : notInstalling === 'unbuilt'
                ? 'Update has no build yet'
                : notInstalling === 'fetching'
                  ? 'Update being fetched'
                  : notInstalling === 'unreachable'
                    ? 'Update not staged'
                    : 'Update waiting'
          }
          description={
            <Text size="sm" c="dimmed" role="status" aria-label="Update status">
              {progress}
            </Text>
          }
        >
          {canInstallNow ? (
            <Button
              variant="default"
              size="xs"
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

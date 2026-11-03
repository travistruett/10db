import { Switch } from '@mantine/core';
import { useSelfUpdate, useSetSelfUpdate } from '../../daemon/self-update-queries';
import { SettingRow, SettingsCard } from './setting-row';

const SHORT = 7;
const short = (commit: string): string => commit.slice(0, SHORT);

/**
 * Lets 10db install main's newest finished build by itself, when no task is mid-session. One setting
 * for the whole app, on until the builder turns it off. It follows the repository this app was built
 * from, not a project's.
 */
export function SelfUpdateSection() {
  const status = useSelfUpdate();
  const set = useSetSelfUpdate();
  const data = status.data;
  const running =
    data === undefined
      ? null
      : data.runningCommit === null
        ? 'This app is running from source, so it never updates itself.'
        : `Running ${short(data.runningCommit)}.`;
  const waiting =
    data?.availableCommit != null && data.enabled
      ? ` ${short(data.availableCommit)} is on main; 10db installs its newest finished build when no task is mid-session.`
      : '';
  return (
    <SettingsCard>
      <SettingRow
        label="Update 10db by itself"
        description={`When main has new commits and no task is mid-session, install its newest finished build and restart. Queued and waiting tasks carry on. It follows the repository this app was built from, whatever your projects are. ${running ?? ''}${waiting}`.trim()}
      >
        <Switch
          aria-label="Update 10db by itself"
          checked={data?.enabled ?? false}
          disabled={data === undefined || set.isPending}
          onChange={(event) => {
            set.mutate(event.currentTarget.checked);
          }}
        />
      </SettingRow>
    </SettingsCard>
  );
}

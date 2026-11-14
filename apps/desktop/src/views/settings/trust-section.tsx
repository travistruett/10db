import {
  JudgeKind,
  type AccountJudgeDto,
  type InstalledPluginDto,
  type TrustSwitches,
} from '@10db/contracts';
import { Alert, Button, Divider, Group, Paper, Stack, Switch, Text, Title } from '@mantine/core';
import { Fragment, useId } from 'react';
import { useSetTrust, useTrust } from '../../daemon/trust-queries';
import { SettingRow, SettingsCard } from './setting-row';
import { JUDGE_LABELS, NATIVE_JUDGE_NOTE, TRUST_ROWS } from './trust-rows';

/** A row's description with the note on each agent under it. */
export function TrustRowText({
  description,
  providers,
}: {
  readonly description: string;
  readonly providers: string;
}) {
  return (
    <>
      {description}
      <Text component="span" display="block" size="xs" c="dimmed" mt={4}>
        {providers}
      </Text>
    </>
  );
}

/** A plugin's version, and that Claude Code has it off until the builder switches it here. */
function PluginText({
  plugin,
  switches,
}: {
  readonly plugin: InstalledPluginDto;
  readonly switches: TrustSwitches;
}) {
  const offInClaude = !plugin.enabledInClaude && switches.plugins[plugin.id] === undefined;
  return (
    <>
      <span>{plugin.version}</span>
      {offInClaude ? (
        <>
          <span> · </span>
          <span>Off in Claude Code</span>
        </>
      ) : null}
    </>
  );
}

/** The plugin switches without `id`'s, so it follows Claude Code again. */
function without(plugins: Readonly<Record<string, boolean>>, id: string): Record<string, boolean> {
  return Object.fromEntries(Object.entries(plugins).filter(([key]) => key !== id));
}

/** What a judge row adds under its model: the fallback a native judge has, or why the rules judge. */
function judgeNote(row: AccountJudgeDto): string | null {
  switch (row.judge) {
    case JudgeKind.Native:
      return NATIVE_JUDGE_NOTE;
    case JudgeKind.Rules:
      return row.why;
    case JudgeKind.Tendb:
      return null;
  }
}

/** Who judges a new task's calls on each account, on the model it would run; read-only. */
function JudgeList({ judges }: { readonly judges: readonly AccountJudgeDto[] }) {
  const headingId = useId();
  return (
    <Stack gap="xs" role="region" aria-labelledby={headingId}>
      <Title order={5} id={headingId}>
        Judge
      </Title>
      <Text size="sm" c="dimmed">
        What decides a new task's routine calls on each account, on the model it would run.
      </Text>
      <Paper withBorder radius="md" component="ul" m={0} p={0} style={{ listStyle: 'none' }}>
        {judges.map((row, i) => (
          <Fragment key={row.accountId}>
            {i > 0 ? <Divider component="li" aria-hidden /> : null}
            <JudgeRow row={row} />
          </Fragment>
        ))}
      </Paper>
    </Stack>
  );
}

function JudgeRow({ row }: { readonly row: AccountJudgeDto }) {
  const labelId = useId();
  const note = judgeNote(row);
  return (
    <Group
      component="li"
      aria-labelledby={labelId}
      justify="space-between"
      align="flex-start"
      wrap="nowrap"
      gap="md"
      px="md"
      py="sm"
    >
      <Stack gap={2} miw={0}>
        <Text size="sm" fw={500} id={labelId}>
          {row.label}
        </Text>
        <Text size="sm" c="dimmed">
          {row.model ?? 'No model offered'}
        </Text>
        {note === null ? null : (
          <Text size="xs" c="dimmed">
            {note}
          </Text>
        )}
      </Stack>
      <Text size="sm" ta="right">
        {JUDGE_LABELS[row.judge]}
      </Text>
    </Group>
  );
}

/** Settings › Trust: what comes along into every session, app-wide, and the builder's plugins. */
export function TrustSection() {
  const trust = useTrust();
  const set = useSetTrust();
  const switches = trust.data?.switches;
  const plugins = trust.data?.plugins ?? [];
  if (trust.isError) return <Alert color="red">{trust.error.message}</Alert>;
  return (
    <Stack gap="lg">
      <SettingsCard>
        {TRUST_ROWS.map((row) => (
          <SettingRow
            key={row.key}
            label={row.label}
            description={<TrustRowText description={row.description} providers={row.providers} />}
          >
            <Group justify="flex-end">
              <Switch
                aria-label={row.label}
                checked={switches?.[row.key] ?? false}
                disabled={switches === undefined}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  set.mutate((saved) => ({ ...saved, [row.key]: on }));
                }}
              />
            </Group>
          </SettingRow>
        ))}
      </SettingsCard>
      <SettingsCard title="Your plugins">
        {switches !== undefined && plugins.length === 0 ? (
          <Text size="sm" c="dimmed" px="md" py="sm">
            Claude Code lists no plugins installed for you.
          </Text>
        ) : null}
        {switches === undefined
          ? null
          : plugins.map((plugin) => (
              <SettingRow
                key={plugin.id}
                label={plugin.id}
                description={<PluginText plugin={plugin} switches={switches} />}
              >
                <Group justify="flex-end" gap="xs" wrap="nowrap">
                  {switches.plugins[plugin.id] === undefined ? null : (
                    <Button
                      variant="subtle"
                      size="compact-xs"
                      aria-label={`Follow Claude Code: ${plugin.id}`}
                      disabled={!switches.yourPlugins}
                      onClick={() => {
                        set.mutate((saved) => ({
                          ...saved,
                          plugins: without(saved.plugins, plugin.id),
                        }));
                      }}
                    >
                      Follow Claude Code
                    </Button>
                  )}
                  <Switch
                    aria-label={plugin.id}
                    checked={plugin.on}
                    // With Your plugins off no plugin comes along, whatever its own switch says.
                    disabled={!switches.yourPlugins}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      set.mutate((saved) => ({
                        ...saved,
                        plugins: { ...saved.plugins, [plugin.id]: on },
                      }));
                    }}
                  />
                </Group>
              </SettingRow>
            ))}
      </SettingsCard>
      {trust.data === undefined ? null : <JudgeList judges={trust.data.judges} />}
    </Stack>
  );
}

import type { InstalledPluginDto, TrustSwitches } from '@10db/contracts';
import { Group, Stack, Switch, Text } from '@mantine/core';
import { useSetTrust, useTrust } from '../../daemon/trust-queries';
import { SettingRow, SettingsCard } from './setting-row';
import { TRUST_ROWS } from './trust-rows';

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

/** Settings › Trust: what comes along into every session, app-wide, and the builder's plugins. */
export function TrustSection() {
  const trust = useTrust();
  const set = useSetTrust();
  const switches = trust.data?.switches;
  const plugins = trust.data?.plugins ?? [];
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
                  if (switches !== undefined)
                    set.mutate({ ...switches, [row.key]: e.currentTarget.checked });
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
                <Group justify="flex-end">
                  <Switch
                    aria-label={plugin.id}
                    checked={plugin.on}
                    onChange={(e) => {
                      set.mutate({
                        ...switches,
                        plugins: { ...switches.plugins, [plugin.id]: e.currentTarget.checked },
                      });
                    }}
                  />
                </Group>
              </SettingRow>
            ))}
      </SettingsCard>
    </Stack>
  );
}

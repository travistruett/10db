import type { InstalledPluginDto, TrustSwitches } from '@10db/contracts';
import { Alert, Button, Group, Stack, Switch, Text } from '@mantine/core';
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

/** The plugin switches without `id`'s, so it follows Claude Code again. */
function without(plugins: Readonly<Record<string, boolean>>, id: string): Record<string, boolean> {
  return Object.fromEntries(Object.entries(plugins).filter(([key]) => key !== id));
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
    </Stack>
  );
}

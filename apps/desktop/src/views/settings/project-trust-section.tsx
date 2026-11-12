import {
  TrustOverrides,
  type ProjectDto,
  type SetupPreviewDto,
  type TrustSwitchKey,
} from '@10db/contracts';
import { List, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import { useId } from 'react';
import { useProjectTrust, useSetProjectTrust, useTrust } from '../../daemon/trust-queries';
import { SettingRow, SettingsCard } from './setting-row';
import { TrustRowText } from './trust-section';
import { TRUST_ROWS } from './trust-rows';

const Choice = { App: 'app', On: 'on', Off: 'off' } as const;
type Choice = (typeof Choice)[keyof typeof Choice];

const CHOICES = [
  { value: Choice.App, label: 'As app' },
  { value: Choice.On, label: 'On' },
  { value: Choice.Off, label: 'Off' },
];

function isChoice(value: string): value is Choice {
  return value === Choice.App || value === Choice.On || value === Choice.Off;
}

function choiceOf(value: boolean | undefined): Choice {
  if (value === undefined) return Choice.App;
  return value ? Choice.On : Choice.Off;
}

/** `record` with `key` set to `value`, or without it when `value` is undefined (As app). */
function setOrClear<T>(
  record: Readonly<Record<string, T>>,
  key: string,
  value: T | undefined,
): Record<string, T> {
  const rest = Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
  return value === undefined ? rest : { ...rest, [key]: value };
}

/** The overrides with one switch set, or removed for As app; parsed, so only known keys go. */
function withSwitch(
  overrides: TrustOverrides,
  key: TrustSwitchKey,
  value: boolean | undefined,
): TrustOverrides {
  const { plugins, ...switches } = overrides;
  return TrustOverrides.parse({
    ...setOrClear(switches, key, value),
    ...(plugins === undefined ? {} : { plugins }),
  });
}

/** The overrides with one plugin set, or removed for As app; no plugins key once none is left. */
function withPlugin(
  overrides: TrustOverrides,
  id: string,
  value: boolean | undefined,
): TrustOverrides {
  const { plugins, ...switches } = overrides;
  const next = setOrClear(plugins ?? {}, id, value);
  return Object.keys(next).length === 0 ? switches : { ...switches, plugins: next };
}

function boolOf(choice: Choice): boolean | undefined {
  if (choice === Choice.App) return undefined;
  return choice === Choice.On;
}

/** What would load into the project's next session, and what was left out and why. */
function ComesAlong({ preview }: { readonly preview: SetupPreviewDto | undefined }) {
  const headingId = useId();
  const loaded = [...(preview?.skills ?? []), ...(preview?.plugins ?? [])];
  return (
    <Stack gap="xs" role="region" aria-labelledby={headingId}>
      <Title order={5} id={headingId}>
        Comes along
      </Title>
      {preview === undefined ? null : (
        <>
          <Text size="sm" c="dimmed">
            What the project's next session starts with, as your switches and its overrides stand.
          </Text>
          {loaded.length === 0 ? (
            <Text size="sm">Nothing of yours or the project's.</Text>
          ) : (
            <List size="sm">
              {loaded.map((name) => (
                <List.Item key={name}>{name}</List.Item>
              ))}
            </List>
          )}
          {preview.leftOut.length === 0 ? null : (
            <>
              <Text size="sm" fw={500}>
                Left out
              </Text>
              <List size="sm">
                {preview.leftOut.map((item) => (
                  <List.Item key={`${item.what} ${item.why}`}>
                    <Text component="span" size="sm">
                      {item.what}
                    </Text>
                    <Text component="span" size="sm" c="dimmed">
                      {': '}
                    </Text>
                    <Text component="span" size="sm" c="dimmed">
                      {item.why}
                    </Text>
                  </List.Item>
                ))}
              </List>
            </>
          )}
        </>
      )}
    </Stack>
  );
}

/** A project's Trust: each switch as the app has it, or on or off for this project alone. */
export function ProjectTrustSection({ project }: { readonly project: ProjectDto }) {
  const trust = useProjectTrust(project.id);
  const app = useTrust();
  const set = useSetProjectTrust(project.id);
  const overrides = trust.data?.overrides;
  const plugins = app.data?.plugins ?? [];
  return (
    <Stack gap="lg">
      <SettingsCard>
        {TRUST_ROWS.map((row) => (
          <SettingRow
            key={row.key}
            label={row.label}
            description={<TrustRowText description={row.description} providers={row.providers} />}
          >
            <SegmentedControl
              aria-label={row.label}
              fullWidth
              disabled={overrides === undefined}
              value={choiceOf(overrides?.[row.key])}
              data={CHOICES}
              onChange={(value) => {
                if (overrides !== undefined && isChoice(value))
                  set.mutate(withSwitch(overrides, row.key, boolOf(value)));
              }}
            />
          </SettingRow>
        ))}
      </SettingsCard>
      {plugins.length === 0 ? null : (
        <SettingsCard title="Your plugins in this project">
          {plugins.map((plugin) => (
            <SettingRow key={plugin.id} label={plugin.id} description={plugin.version}>
              <SegmentedControl
                aria-label={plugin.id}
                fullWidth
                disabled={overrides === undefined}
                value={choiceOf(overrides?.plugins?.[plugin.id])}
                data={CHOICES}
                onChange={(value) => {
                  if (overrides !== undefined && isChoice(value))
                    set.mutate(withPlugin(overrides, plugin.id, boolOf(value)));
                }}
              />
            </SettingRow>
          ))}
        </SettingsCard>
      )}
      <ComesAlong preview={trust.data?.preview} />
    </Stack>
  );
}

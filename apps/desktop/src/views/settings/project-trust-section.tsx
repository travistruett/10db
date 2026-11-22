import {
  AccountKind,
  LIVE_SYSTEM_MAX_CHARS,
  LIVE_SYSTEMS_MAX,
  TrustOverrides,
  type ProjectDto,
  type SetupPreviewDto,
  YourMcpServerState,
  type TrustSwitchKey,
} from '@10db/contracts';
import {
  Alert,
  Button,
  Group,
  List,
  SegmentedControl,
  Stack,
  TagsInput,
  Text,
  Title,
} from '@mantine/core';
import { useId, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useAccounts } from '../../daemon/account-queries';
import { DaemonRequestError } from '../../daemon/client';
import {
  useLiveSystems,
  useProjectTrust,
  useRemoveTrustGrant,
  useSetLiveSystems,
  useSetProjectTrust,
  useTrust,
  useTrustGrants,
} from '../../daemon/trust-queries';
import { SettingRow, SettingsCard } from './setting-row';
import { TrustRowText } from './trust-section';
import {
  GRANTS_DESCRIPTION,
  GRANTS_EMPTY,
  grantDescription,
  LIVE_SYSTEMS_DESCRIPTION,
  TRUST_ROWS,
} from './trust-rows';

const Choice = { App: 'app', On: 'on', Off: 'off' } as const;
type Choice = (typeof Choice)[keyof typeof Choice];

const CHOICES = [
  { value: Choice.App, label: 'As App' },
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

/** The overrides with one MCP server set, or removed for As app; no mcpServers key once none is left. */
function withMcpServer(
  overrides: TrustOverrides,
  key: string,
  value: boolean | undefined,
): TrustOverrides {
  const { mcpServers, ...rest } = overrides;
  const next = setOrClear(mcpServers ?? {}, key, value);
  return TrustOverrides.parse(
    Object.keys(next).length === 0 ? rest : { ...rest, mcpServers: next },
  );
}

function boolOf(choice: Choice): boolean | undefined {
  if (choice === Choice.App) return undefined;
  return choice === Choice.On;
}

/** A list that starts folded under how many items it holds, with a control to show it. */
function FoldedList({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap="xs">
      <Group gap="sm">
        <Text size="sm">{count === 1 ? '1 item' : String(count) + ' items'}</Text>
        <Button
          variant="subtle"
          size="compact-sm"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} ${title}`}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? 'Hide' : 'Show'}
        </Button>
      </Group>
      {open ? children : null}
    </Stack>
  );
}

/** What would load into the project's next session, and what was left out and why. */
function ComesAlong({ preview }: { readonly preview: SetupPreviewDto | undefined }) {
  const headingId = useId();
  const loaded = [...(preview?.skills ?? []), ...(preview?.plugins ?? [])];
  return (
    <Stack gap="xs" role="region" aria-labelledby={headingId}>
      <Title order={5} id={headingId}>
        Comes Along
      </Title>
      {preview === undefined ? null : (
        <>
          <Text size="sm" c="dimmed">
            What the project's next session starts with, as your switches and its overrides stand.
          </Text>
          {loaded.length === 0 ? (
            <Text size="sm">Nothing of yours or the project's.</Text>
          ) : (
            <FoldedList title="Comes along" count={loaded.length}>
              <List size="sm">
                {loaded.map((name) => (
                  <List.Item key={name}>{name}</List.Item>
                ))}
              </List>
            </FoldedList>
          )}
          {preview.leftOut.length === 0 ? null : (
            <>
              <Title order={5}>Left Out</Title>
              <FoldedList title="Left out" count={preview.leftOut.length}>
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
              </FoldedList>
            </>
          )}
        </>
      )}
    </Stack>
  );
}

const RefusedList = z.object({ issues: z.array(z.object({ message: z.string() })).min(1) });

/** Why the daemon refused a list, without the field paths the builder never sees. */
function refusal(error: Error | null): string | undefined {
  if (error === null) return undefined;
  const refused = error instanceof DaemonRequestError ? RefusedList.safeParse(error.body) : null;
  return refused?.success === true
    ? [...new Set(refused.data.issues.map((issue) => issue.message))].join('; ')
    : error.message;
}

/**
 * The project's live systems. A change is sent at once and shows while it is on its way; one the daemon
 * refuses shows why under the input and leaves the saved list.
 */
function LiveSystems({ projectId }: { readonly projectId: ProjectDto['id'] }) {
  const live = useLiveSystems(projectId);
  const set = useSetLiveSystems(projectId);
  const saved = live.data?.liveSystems;
  const shown = set.isPending ? set.variables : (saved ?? []);
  return (
    <SettingsCard>
      <SettingRow label="Live Systems" description={LIVE_SYSTEMS_DESCRIPTION} stacked>
        <TagsInput
          aria-label="Live Systems"
          value={[...shown]}
          maxTags={LIVE_SYSTEMS_MAX}
          maxLength={LIVE_SYSTEM_MAX_CHARS}
          disabled={saved === undefined}
          error={live.error?.message ?? refusal(set.error)}
          onChange={(next) => {
            set.mutate(next);
          }}
        />
      </SettingRow>
    </SettingsCard>
  );
}

/** What the builder allowed in this project from now on, each line with its limit, its date and Remove. */
function AllowedInProject({ projectId }: { readonly projectId: ProjectDto['id'] }) {
  const grants = useTrustGrants(projectId);
  const remove = useRemoveTrustGrant(projectId);
  const headingId = useId();
  const listed = grants.data ?? [];
  return (
    <Stack gap="xs" role="region" aria-labelledby={headingId}>
      <Title order={5} id={headingId}>
        Allowed in This Project
      </Title>
      <Text size="sm" c="dimmed">
        {GRANTS_DESCRIPTION}
      </Text>
      {grants.isError ? <Alert color="red">{grants.error.message}</Alert> : null}
      {remove.isError ? <Alert color="red">{remove.error.message}</Alert> : null}
      {grants.data !== undefined && listed.length === 0 ? (
        <Text size="sm">{GRANTS_EMPTY}</Text>
      ) : (
        <SettingsCard>
          {listed.map((grant) => (
            <SettingRow
              key={grant.id}
              label={grant.target}
              description={grantDescription(grant, new Date(grant.createdAt).toLocaleDateString())}
            >
              <Button
                variant="subtle"
                color="red"
                size="xs"
                aria-label={`Remove ${grant.target}`}
                loading={remove.isPending && remove.variables === grant.id}
                onClick={() => {
                  remove.mutate(grant.id);
                }}
              >
                Remove
              </Button>
            </SettingRow>
          ))}
        </SettingsCard>
      )}
    </Stack>
  );
}

/** What Codex's search does through OpenRouter, which the spike found live and absent from the transcript. */
const OPENROUTER_WEB = "On OpenRouter, web search is live and doesn't show in the transcript.";

/** A project's Trust: each switch as the app has it, or on or off for this project alone. */
export function ProjectTrustSection({ project }: { readonly project: ProjectDto }) {
  const trust = useProjectTrust(project.id);
  const app = useTrust();
  const set = useSetProjectTrust(project.id);
  const accounts = useAccounts();
  const onOpenRouter =
    accounts.data?.find((a) => a.id === project.accountId)?.kind === AccountKind.OpenRouter;
  const overrides = trust.data?.overrides;
  const plugins = app.data?.plugins ?? [];
  const mcpServers = (app.data?.mcpServers ?? []).filter(
    (server) => server.state === YourMcpServerState.Approved,
  );
  if (trust.isError) return <Alert color="red">{trust.error.message}</Alert>;
  return (
    <Stack gap="lg">
      <SettingsCard>
        {TRUST_ROWS.map((row) => (
          <SettingRow
            key={row.key}
            label={row.label}
            description={
              <TrustRowText
                description={
                  row.key === 'web' && onOpenRouter
                    ? `${row.description} ${OPENROUTER_WEB}`
                    : row.description
                }
                providers={row.providers}
                whileOn={
                  (overrides?.[row.key] ?? app.data?.switches[row.key]) === true
                    ? row.whileOn
                    : null
                }
              />
            }
          >
            <SegmentedControl
              aria-label={row.label}
              fullWidth
              disabled={overrides === undefined}
              value={choiceOf(overrides?.[row.key])}
              data={CHOICES}
              onChange={(value) => {
                if (isChoice(value))
                  set.mutate((saved) => withSwitch(saved, row.key, boolOf(value)));
              }}
            />
          </SettingRow>
        ))}
      </SettingsCard>
      {plugins.length === 0 ? null : (
        <SettingsCard title="Your Plugins in This Project">
          {plugins.map((plugin) => (
            <SettingRow key={plugin.id} label={plugin.id} description={plugin.version}>
              <SegmentedControl
                aria-label={plugin.id}
                fullWidth
                disabled={overrides === undefined}
                value={choiceOf(overrides?.plugins?.[plugin.id])}
                data={CHOICES}
                onChange={(value) => {
                  if (isChoice(value))
                    set.mutate((saved) => withPlugin(saved, plugin.id, boolOf(value)));
                }}
              />
            </SettingRow>
          ))}
        </SettingsCard>
      )}
      {mcpServers.length === 0 ? null : (
        <SettingsCard title="Your MCP Servers in This Project">
          {mcpServers.map((server) => (
            <SettingRow
              key={server.key}
              label={server.name}
              description="Applies from the next session."
            >
              <SegmentedControl
                aria-label={server.name}
                fullWidth
                disabled={overrides === undefined}
                value={choiceOf(overrides?.mcpServers?.[server.key])}
                data={CHOICES}
                onChange={(value) => {
                  if (isChoice(value))
                    set.mutate((saved) => withMcpServer(saved, server.key, boolOf(value)));
                }}
              />
            </SettingRow>
          ))}
        </SettingsCard>
      )}
      <LiveSystems projectId={project.id} />
      <AllowedInProject projectId={project.id} />
      <ComesAlong preview={trust.data?.preview} />
    </Stack>
  );
}

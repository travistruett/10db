import {
  AccountKind,
  TrustOverrides,
  type ProjectDto,
  YourMcpServerState,
  type TrustSwitchKey,
} from '@10db/contracts';
import { Alert, Button, SegmentedControl, Stack, Text } from '@mantine/core';
import { useId } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import {
  useProjectTrust,
  useRemoveTrustGrant,
  useSetProjectTrust,
  useTrust,
  useTrustGrants,
} from '../../daemon/trust-queries';
import { HelpHint } from './help-hint';
import { SettingRow, SettingsCard } from './setting-row';
import { StandingApprovals } from './standing-approvals';
import { TrustRowText } from './trust-section';
import { GRANTS_DESCRIPTION, GRANTS_EMPTY, grantDescription, TRUST_ROWS } from './trust-rows';
import { previewItems } from './trust/preview-items';
import { ProductionSystems } from './trust/production-systems';
import { RepoMcpServers } from './trust/repo-mcp-servers';
import { OtherAndExpected, SwitchItems } from './trust/switch-items';
import { SectionHeading } from './section-heading';

/** The one line under each switch; the full account sits behind its info button. */
const SHORT: Readonly<Record<TrustSwitchKey, string>> = {
  web: 'Lets sessions search and fetch the web.',
  projectInstructions: 'AGENTS.md, CLAUDE.md and rules.',
  yourInstructions: 'Your ~/.claude/CLAUDE.md.',
  yourSkills: 'Skills from your home folder.',
  yourPlugins: 'Plugins installed in Claude Code.',
  yourMcpServers: 'MCP servers you have approved.',
  projectSkills: "The project's skills, commands and agents.",
};

const Choice = { App: 'app', On: 'on', Off: 'off' } as const;
type Choice = (typeof Choice)[keyof typeof Choice];

/** Default follows All Projects › Trust and says what that is now, when it is known. */
function choices(appValue: boolean | undefined) {
  return [
    {
      value: Choice.App,
      label: appValue === undefined ? 'Default' : `Default · ${appValue ? 'On' : 'Off'}`,
    },
    { value: Choice.On, label: 'On' },
    { value: Choice.Off, label: 'Off' },
  ];
}

function isChoice(value: string): value is Choice {
  return value === Choice.App || value === Choice.On || value === Choice.Off;
}

function choiceOf(value: boolean | undefined): Choice {
  if (value === undefined) return Choice.App;
  return value ? Choice.On : Choice.Off;
}

/** `record` with `key` set to `value`, or without it when `value` is undefined (Default). */
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

/** What the builder allowed in this project from now on, each line with its limit, its date and Remove. */
function AllowedInProject({ projectId }: { readonly projectId: ProjectDto['id'] }) {
  const grants = useTrustGrants(projectId);
  const remove = useRemoveTrustGrant(projectId);
  const headingId = useId();
  const listed = grants.data ?? [];
  return (
    <Stack gap="xs" role="region" aria-labelledby={headingId}>
      <SectionHeading
        id={headingId}
        title="Allowed in This Project"
        line="Lines you allowed from now on."
        help={GRANTS_DESCRIPTION}
      />
      {grants.isError ? <Alert color="red">{grants.error.message}</Alert> : null}
      {remove.isError ? <Alert color="red">{remove.error.message}</Alert> : null}
      {grants.data !== undefined && listed.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing yet.
          <HelpHint label="Allowing a call">{GRANTS_EMPTY}</HelpHint>
        </Text>
      ) : (
        <SettingsCard>
          {listed.map((grant) => (
            <SettingRow
              key={grant.id}
              label={grant.target}
              description={grantDescription(grant, new Date(grant.createdAt).toLocaleDateString())}
            >
              <Button
                variant="default"
                size="compact-sm"
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
  const items = previewItems(trust.data?.preview);
  const plugins = app.data?.plugins ?? [];
  const mcpServers = (app.data?.mcpServers ?? []).filter(
    (server) => server.state === YourMcpServerState.Approved,
  );
  if (trust.isError) return <Alert color="red">{trust.error.message}</Alert>;
  return (
    <Stack gap="lg">
      <SettingsCard title="What Comes Along">
        {TRUST_ROWS.map((row) => (
          <SettingRow
            key={row.key}
            label={row.label}
            description={SHORT[row.key]}
            below={<SwitchItems label={row.label} items={items.bySwitch.get(row.key) ?? []} />}
            help={
              <TrustRowText
                label={row.label}
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
              size="xs"
              fullWidth
              disabled={overrides === undefined}
              value={choiceOf(overrides?.[row.key])}
              data={choices(app.data?.switches[row.key])}
              onChange={(value) => {
                if (isChoice(value))
                  set.mutate((saved) => withSwitch(saved, row.key, boolOf(value)));
              }}
            />
          </SettingRow>
        ))}
      </SettingsCard>
      <OtherAndExpected other={items.other} expected={items.expected} />
      {plugins.length === 0 ? null : (
        <SettingsCard title="Your Plugins">
          {plugins.map((plugin) => (
            <SettingRow key={plugin.id} label={plugin.id} description={plugin.version}>
              <SegmentedControl
                aria-label={plugin.id}
                size="xs"
                fullWidth
                disabled={overrides === undefined}
                value={choiceOf(overrides?.plugins?.[plugin.id])}
                data={choices(plugin.on)}
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
        <SettingsCard title="Your MCP Servers">
          {mcpServers.map((server) => (
            <SettingRow key={server.key} label={server.name}>
              <SegmentedControl
                aria-label={server.name}
                size="xs"
                fullWidth
                disabled={overrides === undefined}
                value={choiceOf(overrides?.mcpServers?.[server.key])}
                data={choices(undefined)}
                onChange={(value) => {
                  if (isChoice(value))
                    set.mutate((saved) => withMcpServer(saved, server.key, boolOf(value)));
                }}
              />
            </SettingRow>
          ))}
        </SettingsCard>
      )}
      <RepoMcpServers projectId={project.id} />
      <ProductionSystems projectId={project.id} />
      <StandingApprovals projectId={project.id} />
      <AllowedInProject projectId={project.id} />
    </Stack>
  );
}

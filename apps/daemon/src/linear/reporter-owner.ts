import {
  AccountKind,
  ConversationItemKind,
  DeniedBy,
  LinearVia,
  parseItemBody,
  ReporterToolName,
  TrustSurface,
  type Effort,
  type LinearPostDto,
  type LinearSignInsDto,
  type Provider,
  type ProjectId,
  type SessionId,
} from '@10db/contracts';
import { getProject } from '@10db/db';
import { pictureLimitsFor, type ExploreOwnerHooks } from '../conversation';
import type { AccountExpectation } from '../environment';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { trustSwitchesFor, warnInvalidTrust } from '../permissions';
import type { LaneSandboxSpec } from '../sandbox';
import type { YourSessionServer } from '../sessions';
import { buildTrustPolicy } from '../trust';
import { linearToolPrefixes } from './reporter-guard';
import type { LinearReporter, LinearReporterRuns } from './reporter';

// The Linear reporter as an owner of the explore engine (Linear reporter plan, card 4). Its session is the
// smallest one 10db opens: no built-in tool but ToolSearch, no repository server, no plugin, no agent and no
// web, with Linear's tools and 10db's two report tools, every call answered by the reporter's own rule.

/** The share of the context window past which a session would continue fresh; a run never gets near it. */
const FRESH_AT_CONTEXT_PCT = 70;

const REPORTER_TOOLS: readonly string[] = Object.values(ReporterToolName).map(
  (name) => `mcp__10db__${name}`,
);

const SYSTEM_PROMPT = [
  "You are 10db's Linear reporter. You keep one Linear issue up to date from the facts you are given.",
  "You have Linear's tools and one of 10db's: report_linear_post. Nothing else works.",
  'Write only to the linked issue, named by its Linear id. When you have finished an update, record it with report_linear_post.',
].join('\n');

const NOTHING_TO_ASK = 'The reporter runs no tool but Linear and 10db’s two report tools.';

/** What a run's launch needs of the project's account: its Efficient tier model, and how to open it. */
export interface ReporterLaunch {
  readonly cwd: string;
  /** What the account launches the model with. */
  readonly model: string;
  readonly modelId: string;
  readonly effort: Effort;
  readonly env: Readonly<Record<string, string>>;
  readonly account: AccountExpectation;
}

/** What preparing a run's session made: the sandbox and Linear's servers, and how to take them down. */
export interface ReporterPrepared {
  readonly sandbox: LaneSandboxSpec | null;
  /** Only the account's `mcp.linear.app` entries. */
  readonly yourMcpServers: Readonly<Record<string, YourSessionServer>>;
  readonly credentialsExpireAt: string | null;
  track(pid: number): void;
  release(): Promise<void>;
}

export interface ReporterHooksDeps {
  readonly state: StateStore;
  readonly log: Logger;
  readonly mcp: { readonly url: string };
  readonly runs: LinearReporterRuns & Pick<LinearReporter, 'verdict' | 'observe'>;
  readonly signIns: { list(): Promise<LinearSignInsDto> };
  /** The project account's Efficient-tier launch. */
  launch(projectId: ProjectId): ReporterLaunch;
  prepare(input: {
    readonly projectId: ProjectId;
    readonly sessionId: SessionId;
    readonly harness: Provider;
    readonly env: Readonly<Record<string, string>>;
  }): Promise<ReporterPrepared>;
}

/** The rows a run reports, one line each; the facts of the task come with the brief. */
function rowLines(posts: readonly LinearPostDto[]): string {
  return posts
    .map((p) => `- ${p.id}: ${p.event}, attempt ${String(p.attempt)}, ${JSON.stringify(p.detail)}`)
    .join('\n');
}

export function reporterHooks(deps: ReporterHooksDeps): ExploreOwnerHooks {
  const { state } = deps;
  const describe = (projectId: ProjectId) => {
    const launch = deps.launch(projectId);
    return {
      launch,
      view: {
        model: launch.modelId,
        label: launch.modelId,
        launchId: launch.model,
        effort: launch.effort,
      },
    };
  };

  return {
    freshAtContextPct: FRESH_AT_CONTEXT_PCT,

    async spec(conv, start) {
      const project = getProject(state.db, conv.projectId);
      const { launch } = describe(conv.projectId);
      const harness = launch.account.harness;
      const prepared = await deps.prepare({
        projectId: conv.projectId,
        sessionId: start.sessionId,
        harness,
        env: launch.env,
      });
      try {
        // The claude.ai connector is loaded only on a plan whose Linear is one, or whose connector list is unread.
        const row = (await deps.signIns.list()).rows.find((r) => r.accountId === project.accountId);
        const connector =
          launch.account.kind === AccountKind.ClaudeSubscription &&
          row !== undefined &&
          (row.via === LinearVia.Connector || (row.via === LinearVia.None && row.unchecked));
        const { posts, run } = deps.runs.begin({
          conversationId: conv.id,
          sessionId: start.sessionId,
          linearPrefixes: linearToolPrefixes({
            connector,
            entries: Object.keys(prepared.yourMcpServers),
            harness,
          }),
        });
        const policy = buildTrustPolicy({
          surface: TrustSurface.Chat,
          projectName: project.name,
          checkout: launch.cwd,
          gateCommand: project.gateCommand,
          liveSystems: [],
          switches: trustSwitchesFor(state.db, project.id, warnInvalidTrust(deps.log)),
          grants: [],
          yourMcpServers: Object.keys(prepared.yourMcpServers),
          claudeConnectors: connector,
        });
        const prompt = [
          `These updates are owed on the linked issue (${run.link.id}, Linear id ${run.link.issueId}, ${run.link.url}):\n${rowLines(posts)}`,
          start.first.text,
        ].join('\n\n');
        return {
          spec: {
            sessionId: start.sessionId,
            conversationId: conv.id,
            policy,
            profile: {
              kind: 'explore',
              systemPrompt: SYSTEM_PROMPT,
              tools: ['ToolSearch'],
              allowedTools: REPORTER_TOOLS,
              disallowedTools: [],
              agents: {},
            },
            cwd: launch.cwd,
            instructions: null,
            prompt,
            model: launch.model,
            effort: launch.effort,
            resumeProviderSessionId: null,
            env: launch.env,
            account: launch.account,
            // Codex's search runs at OpenAI with no hook call, so it is off whatever the Web switch says.
            webSearch: 'disabled',
            mcp: { url: deps.mcp.url, token: start.mcpToken, toolTimeoutMs: 60_000 },
            hookWaitMs: 60_000,
            sandbox: prepared.sandbox,
            projectMcpServers: {},
            yourMcpServers: prepared.yourMcpServers,
            claudeConnectors: connector,
            canUseTool: () =>
              Promise.resolve({ behavior: 'deny', message: NOTHING_TO_ASK, by: DeniedBy.TenDb }),
            preToolUse: (req) => deps.runs.verdict(start.sessionId, req),
          },
          limits: pictureLimitsFor(launch.account.kind, {
            accountId: launch.account.accountId,
            launchId: launch.model,
          }),
          expiresAt: prepared.credentialsExpireAt,
          accountId: launch.account.accountId,
          model: launch.modelId,
          release: () => prepared.release(),
          track: (pid) => {
            prepared.track(pid);
          },
          observeToolCall: (event) => {
            const call = event.call;
            if (call.kind !== 'mcp' || call.status !== 'done') return;
            const text = event.full?.output ?? call.resultTail;
            if (text === null) return;
            deps.runs.observe(start.sessionId, `mcp__${call.server}__${call.tool}`, text);
          },
        };
      } catch (error) {
        await prepared.release();
        throw error;
      }
    },

    // A run is told what is owed in its first message, so there is nothing to carry over.
    digest: () => '',
    keepsResume: () => false,

    outgoing(_conv, item) {
      const text =
        item.kind === ConversationItemKind.Message ? parseItemBody(item.kind, item.body).text : '';
      return { text, images: [], blocks: [], sent: () => undefined };
    },

    onTurnEnded(conv, end) {
      deps.runs.turnEnded(conv, end);
      return Promise.resolve();
    },

    onState(conv, to) {
      deps.runs.stateChanged(conv, to);
    },

    describeModel: (conv) => describe(conv.projectId).view,
  };
}

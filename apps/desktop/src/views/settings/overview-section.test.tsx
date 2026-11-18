import {
  AgentCopyState,
  CatalogueAttempt,
  CatalogueSource,
  CatalogueStatusDto,
  SelfUpdateStatusDto,
  SystemCheckDto,
  ToolName,
} from '@10db/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { accountDto } from '../../test/account-fixtures';
import { benchmarkStatusDto } from '../../test/benchmark-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { githubStatusDto } from '../../test/github-fixtures';
import { judgeStatusDto, serveJudge } from '../../test/judge-fixtures';
import { slackConnection } from '../../test/people-fixtures';

const CLAUDE_PLAN = accountDto({
  label: 'Claude plan',
  expectedIdentity: 'builder@example.com',
  isDefault: true,
});
const SYNCED = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
const FETCHED = new Date(Date.now() - 2 * 60_000).toISOString();

/** A daemon where every connection works, serving `accounts`. */
function serve(accounts: ReturnType<typeof accountDto>[]) {
  server.use(
    http.get(daemonUrl('/accounts'), () => HttpResponse.json(accounts)),
    http.get(daemonUrl('/github'), () => HttpResponse.json(githubStatusDto())),
    http.get(daemonUrl('/slack'), () =>
      HttpResponse.json(slackConnection({ state: 'connected', teamName: 'Ampsio' })),
    ),
    http.get(daemonUrl('/benchmarks/status'), () =>
      HttpResponse.json(
        benchmarkStatusDto({
          keyConfigured: true,
          outcome: 'ok',
          lastSuccessAt: SYNCED,
          models: 120,
        }),
      ),
    ),
    http.get(daemonUrl('/models/status'), () =>
      HttpResponse.json(
        CatalogueStatusDto.parse({
          fetchedAt: FETCHED,
          source: CatalogueSource.Fetched,
          models: 660,
          lastAttempt: CatalogueAttempt.Succeeded,
        }),
      ),
    ),
    http.get(daemonUrl('/system'), () =>
      HttpResponse.json(
        SystemCheckDto.parse({
          loginEnv: { source: 'login_shell', warning: null },
          claudeCode: { verifiedOn: '2.1.302', warning: null },
          codex: { verifiedOn: '0.154.0', warning: null },
          tools: [],
          agents: [
            {
              tool: ToolName.Claude,
              label: 'Claude Code',
              pinned: '2.1.302',
              state: AgentCopyState.Ready,
              problem: null,
              newerRelease: null,
            },
            {
              tool: ToolName.Codex,
              label: 'Codex',
              pinned: '0.154.0',
              state: AgentCopyState.Ready,
              problem: null,
              newerRelease: null,
            },
          ],
        }),
      ),
    ),
    http.get(daemonUrl('/settings/self-update'), () =>
      HttpResponse.json(
        SelfUpdateStatusDto.parse({
          enabled: true,
          isDefault: true,
          runningCommit: 'a'.repeat(40),
          availableCommit: null,
          notInstalling: null,
          waitMinutes: 15,
          waitingSince: null,
          draining: false,
          drainingSince: null,
          midSession: { working: 0, waitingOnCard: 0, batches: 0, jobs: 0, shapes: [] },
          blocker: null,
        }),
      ),
    ),
    ...baseHandlers(),
  );
  return renderApp('/settings/overview');
}

/** A row's link, not the summary line's link to the same name. */
async function rowLink(name: RegExp): Promise<HTMLElement> {
  const links = await screen.findAllByRole('link', { name });
  const row = links.find(
    (link) => !(link.getAttribute('href') ?? '').startsWith('/settings/overview'),
  );
  if (!row) throw new Error(`no row link named ${String(name)}`);
  return row;
}

describe('Settings › Overview', () => {
  it("says what each account is used by, an OpenRouter account's decisions included", async () => {
    const router = accountDto({ kind: 'openrouter', label: 'OpenRouter', secretSet: true });
    serveJudge({
      status: judgeStatusDto({
        config: { ...judgeStatusDto().config, accountId: router.id },
        account: { id: router.id, label: 'OpenRouter', secretSet: true, secretState: 'set' },
      }),
    });
    serve([CLAUDE_PLAN, router]);
    const plan = await rowLink(/^Claude plan/);
    expect(within(plan).getByText('Used by nothing')).toBeTruthy();
    const openRouter = await rowLink(/^OpenRouter/);
    await waitFor(() => {
      expect(within(openRouter).getByText('Used by: decisions')).toBeTruthy();
    });
  });
});

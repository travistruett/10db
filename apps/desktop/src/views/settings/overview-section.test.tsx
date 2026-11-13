import {
  AgentCopyState,
  CatalogueAttempt,
  CatalogueSource,
  CatalogueStatusDto,
  SelfUpdateStatusDto,
  SystemCheckDto,
  ToolName,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { accountDto } from '../../test/account-fixtures';
import { benchmarkStatusDto } from '../../test/benchmark-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { githubStatusDto } from '../../test/github-fixtures';
import { slackConnection } from '../../test/people-fixtures';

const CLAUDE_PLAN = accountDto({
  label: 'Claude plan',
  expectedIdentity: 'builder@example.com',
  isDefault: true,
});
const SYNCED = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
const FETCHED = new Date(Date.now() - 2 * 60_000).toISOString();
const RUNNING = 'a'.repeat(40);

interface World {
  readonly accounts?: unknown;
  readonly github?: Record<string, unknown>;
  readonly slack?: Record<string, unknown>;
  readonly benchmarks?: Record<string, unknown>;
  readonly agents?: unknown[];
  readonly slackAnswer?: () => Response;
}

/** A daemon where every connection works, with `world` changing what a test is about. */
function serve(world: World = {}) {
  server.use(
    http.get(daemonUrl('/accounts'), () => HttpResponse.json(world.accounts ?? [CLAUDE_PLAN])),
    http.get(daemonUrl('/github'), () => HttpResponse.json(githubStatusDto(world.github))),
    http.get(
      daemonUrl('/slack'),
      world.slackAnswer ??
        (() =>
          HttpResponse.json(
            slackConnection({ state: 'connected', teamName: 'Ampsio', ...world.slack }),
          )),
    ),
    http.get(daemonUrl('/benchmarks/status'), () =>
      HttpResponse.json(
        benchmarkStatusDto({
          keyConfigured: true,
          outcome: 'ok',
          lastSuccessAt: SYNCED,
          models: 120,
          ...world.benchmarks,
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
          agents: world.agents ?? [
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
          runningCommit: RUNNING,
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
  it('says all connections work, counting nothing that is off, and lists a row in each group', async () => {
    serve({ slack: { state: 'off' } });
    // Claude plan, GitHub, AA, models.dev, Claude Code, Codex and self-update work; Slack is off.
    expect(await screen.findByText('All 7 connections work.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Model access' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Services' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Data and downloads' })).toBeTruthy();
    const slack = await rowLink(/^Slack/);
    expect(within(slack).getByText('Off: 10db was started with TENDB_SLACK=off')).toBeTruthy();
    expect(within(slack).getByTestId('connection-dot').getAttribute('data-color')).toBe('gray');
    const github = await rowLink(/^GitHub/);
    expect(within(github).getByText('Signed in as octocat')).toBeTruthy();
    expect(within(github).getByTestId('connection-dot').getAttribute('data-color')).toBe('teal');
    expect(await rowLink(/^models\.dev/)).toBeTruthy();
    expect(screen.getByText('660 models · fetched 2 minutes ago')).toBeTruthy();
    expect(screen.getByText('2.1.302 · ready')).toBeTruthy();
    expect(screen.getByText(`Running ${RUNNING.slice(0, 7)}`)).toBeTruthy();
  });

  it('names what needs the builder as links, puts those rows first and says what stops', async () => {
    serve({ github: { state: 'signed_out', login: null }, benchmarks: { keyConfigured: false } });
    expect(await screen.findByText(/2 need you:/)).toBeTruthy();
    const summary = screen.getByText(/2 need you:/);
    expect(
      within(summary)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['GitHub', '/settings/overview?focus=github'],
      ['Artificial Analysis', '/settings/overview?focus=artificial-analysis'],
    ]);
    const services = screen.getByRole('heading', { name: 'Services' }).parentElement;
    const names = within(services ?? document.body)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    // GitHub and AA need the builder, so they sit above Slack, which works.
    expect(names).toEqual([
      '/settings/integrations?focus=github',
      '/settings/integrations?focus=artificial-analysis',
      '/settings/integrations?focus=slack',
    ]);
    const github = await rowLink(/^GitHub/);
    expect(within(github).getByText('Not signed in')).toBeTruthy();
    expect(within(github).getByTestId('connection-dot').getAttribute('data-color')).toBe('yellow');
    expect(within(github).getByText(/Pull requests, CI checks and self-update stop/)).toBeTruthy();
  });

  it('links each account to its own drawer', async () => {
    serve();
    const plan = await rowLink(/^Claude plan/);
    expect(plan.getAttribute('href')).toBe(`/settings/accounts?focus=${CLAUDE_PLAN.id}`);
  });

  it('a summary name takes the builder to its row, which takes focus', async () => {
    const { router } = serve({ github: { state: 'signed_out', login: null } });
    fireEvent.click(await screen.findByRole('link', { name: 'GitHub' }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ focus: 'github' });
    });
    const row = await rowLink(/^GitHub/);
    await waitFor(() => {
      expect(document.activeElement).toBe(row);
    });
  });

  it('a read that fails says so with Retry, counts as needing the builder, and recovers on Retry', async () => {
    let fail = true;
    serve({
      slackAnswer: () =>
        fail
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json(slackConnection({ state: 'connected', teamName: 'Ampsio' })),
    });
    expect(await screen.findByText(/1 needs you:/)).toBeTruthy();
    expect(screen.getByText("Couldn't read this")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry Slack' }));
    expect(await screen.findByText('All 8 connections work.')).toBeTruthy();
    expect(screen.queryByText("Couldn't read this")).toBeNull();
  });

  it('each row loads on its own while the summary waits for them all', async () => {
    serve();
    server.use(
      http.get(daemonUrl('/benchmarks/status'), async () => {
        await delay('infinite');
        return HttpResponse.json(benchmarkStatusDto());
      }),
    );
    expect(await rowLink(/^GitHub/)).toBeTruthy();
    expect(screen.queryByText(/connections work|need you|needs you/)).toBeNull();
    expect(screen.queryByRole('link', { name: /^Artificial Analysis/ })).toBeNull();
  });
});

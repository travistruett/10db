import { JudgeDecision } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { accountDto } from '../../test/account-fixtures';
import { daemonUrl, renderWithDaemonAndRouter, server } from '../../test/daemon';
import {
  decisionModelDto,
  decisionStatsDto,
  judgeStatusDto,
  serveJudge,
} from '../../test/judge-fixtures';
import { modelMeasuresDto } from '../../test/model-fixtures';
import { DecisionsModelsView } from './decisions-models-view';

const WORK = accountDto({ kind: 'openrouter', label: 'Decisions key', secretSet: true });
const keyed = (off = false) =>
  judgeStatusDto({
    off,
    config: { ...judgeStatusDto().config, accountId: WORK.id },
    account: { id: WORK.id, label: WORK.label, secretSet: true, secretState: 'set' },
  });

const FAST = decisionModelDto({
  id: 'lab/fast-1',
  name: 'Fast One',
  maker: 'Lab',
  costPerMillionUsd: 3,
  secondsPerDecision: 0.8,
  costSource: 'your_calls',
  timeSource: 'openrouter',
});
const FREE = decisionModelDto({
  id: 'lab/free-1',
  name: 'Free One',
  maker: 'Lab',
  inputUsdPerMillion: 0,
  costPerMillionUsd: 0,
  secondsPerDecision: 2,
  costSource: 'openrouter_price',
  timeSource: 'assumed',
});
const GAP = decisionModelDto({ id: 'lab/gap-1', name: 'Gap One', maker: 'Lab' });
const STUCK = decisionModelDto({
  id: 'lab/stuck-1',
  name: 'Stuck One',
  maker: 'Lab',
  costPerMillionUsd: 5,
  secondsPerDecision: 1,
  cantCall: 'It cannot answer in JSON.',
});

const stats = {
  since: '2026-10-14T12:00:00.000Z',
  decisions: [
    decisionStatsDto(JudgeDecision.ReviewSize, {
      calls: 2,
      acted: 2,
      answers: [
        { model: 'lab/fast-1', confidence: 0.9 },
        { model: 'lab/fast-1', confidence: 0.8 },
      ],
    }),
  ],
};

function open(over: { off?: boolean; status?: ReturnType<typeof keyed> } = {}) {
  serveJudge({
    status: over.status ?? keyed(over.off),
    models: [FAST, FREE, GAP, STUCK],
    stats,
  });
  server.use(
    http.get(daemonUrl('/models/measures'), () =>
      HttpResponse.json(
        modelMeasuresDto({
          openRouterIds: ['lab/fast-1'],
          speeds: [
            {
              provider: 'Lab Cloud',
              tokensPerSecond: 70,
              latencyMs: 120,
              measuredAt: new Date().toISOString(),
            },
          ],
          speedsMissing: null,
        }),
      ),
    ),
  );
  return renderWithDaemonAndRouter(<DecisionsModelsView />);
}

describe('the Decisions view of Models', () => {
  it('draws the decisions table, the chart note and the list of decision models', async () => {
    await open();
    expect(
      await screen.findByRole('heading', { name: 'Which model each decision uses' }),
    ).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Decisions' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Time and cost' })).toBeTruthy();
    expect(await screen.findByText(/1 model with no cost or time is not drawn\./)).toBeTruthy();
    const list = await screen.findByRole('table', { name: 'All decision models' });
    const fast = within(list).getByRole('row', { name: /Fast One/ });
    expect(within(fast).getByText('$3')).toBeTruthy();
    expect(within(fast).getByText('0.8 s')).toBeTruthy();
    expect(within(fast).getByText('2')).toBeTruthy();
    expect(within(list).getByRole('row', { name: /Free One/ }).textContent).toContain('Free');
    const gap = within(list).getByRole('row', { name: /Gap One/ });
    expect(within(gap).getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(within(list).getByText('It cannot answer in JSON.')).toBeTruthy();
  });

  it('draws the decisions table while the decision models are still loading', async () => {
    serveJudge({ status: keyed(), stats });
    server.use(http.get(daemonUrl('/judge/models'), () => new Promise<Response>(() => undefined)));
    await renderWithDaemonAndRouter(<DecisionsModelsView />);
    expect(await screen.findByRole('table', { name: 'Decisions' })).toBeTruthy();
    expect(screen.getByText('Reading OpenRouter’s decision models…')).toBeTruthy();
  });

  it('opens the decision drawer from a row of the decisions table', async () => {
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Skip review for small changes' }));
    expect(
      await screen.findByRole('dialog', { name: 'Skip review for small changes' }),
    ).toBeTruthy();
  });

  it('opens a model’s drawer with its speed by provider', async () => {
    await open();
    const list = await screen.findByRole('table', { name: 'All decision models' });
    fireEvent.click(within(list).getByRole('button', { name: 'Open Fast One' }));
    const drawer = await screen.findByRole('dialog', { name: 'Fast One' });
    expect(within(drawer).getByText('Your calls, last 30 days')).toBeTruthy();
    expect(await within(drawer).findByRole('table', { name: 'Speed by provider' })).toBeTruthy();
    expect(within(drawer).getByText('Lab Cloud')).toBeTruthy();
  });

  it('asks for an OpenRouter account in place of the chart and list, with the Paid by link', async () => {
    await open({ status: judgeStatusDto() });
    expect(await screen.findByRole('table', { name: 'Decisions' })).toBeTruthy();
    expect(await screen.findByText(/Add an OpenRouter account/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Paid by' }).getAttribute('href')).toBe(
      '/settings/decisions?focus=paid-by',
    );
    expect(screen.queryByRole('table', { name: 'All decision models' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Time and cost' })).toBeNull();
  });

  it('says decisions are off and still draws the decisions table when the judge is off', async () => {
    serveJudge({ status: keyed(true) });
    server.use(
      http.get(daemonUrl('/judge/models'), () =>
        HttpResponse.json({ error: 'conflict', message: 'off' }, { status: 409 }),
      ),
    );
    await renderWithDaemonAndRouter(<DecisionsModelsView />);
    expect(await screen.findByRole('table', { name: 'Decisions' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/Decisions are off/)).toBeTruthy();
    });
    expect(screen.queryByRole('table', { name: 'All decision models' })).toBeNull();
  });
});

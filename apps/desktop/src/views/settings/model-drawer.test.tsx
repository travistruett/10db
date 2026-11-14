import type { AccountId } from '@10db/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { accountDto } from '../../test/account-fixtures';
import { modelEffortDto, modelMeasuresDto, modelRowDto } from '../../test/model-fixtures';
import { ModelDrawer } from './model-drawer';

const NOW = new Date();
const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const ACCOUNT = accountDto({ label: 'Work key', kind: 'bedrock' });
const RELAYED = {
  intelligence: 'aa_via_openrouter',
  coding: 'aa_via_openrouter',
  agentic: 'aa_via_openrouter',
  costPerTask: null,
  speed: null,
} as const;

const row = (over: Parameters<typeof modelRowDto>[0] extends infer P ? Partial<P> : never = {}) =>
  modelRowDto({
    model: 'alpha-max',
    name: 'Alpha Max',
    efforts: [modelEffortDto({ effort: 'max', intelligence: 40, costPerTaskUsd: 1.5 })],
    ...over,
  });

function open(
  model: ReturnType<typeof row>,
  account: AccountId | null,
  measures = modelMeasuresDto(),
) {
  const asked: URL[] = [];
  server.use(
    http.get(daemonUrl('/models/measures'), ({ request }) => {
      asked.push(new URL(request.url));
      return HttpResponse.json(measures);
    }),
    ...baseHandlers(),
  );
  renderWithDaemon(
    <ModelDrawer
      row={model}
      opened
      onClose={() => undefined}
      now={NOW.getTime()}
      picks={[]}
      account={account}
    />,
  );
  return asked;
}

describe('the model drawer’s OpenRouter additions', () => {
  it('shows Coding and Agentic with their source when the row has them', async () => {
    open(row({ coding: 52, agentic: 48, sources: RELAYED }), ACCOUNT.id);
    const drawer = await screen.findByRole('dialog', { name: 'Alpha Max' });
    const coding = within(drawer).getByText('52');
    expect(
      document.getElementById(coding.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Artificial Analysis, via OpenRouter');
    expect(within(drawer).getByText('48')).toBeTruthy();
    expect(within(drawer).getByText(/Coding/)).toBeTruthy();
    expect(within(drawer).getByText(/Agentic/)).toBeTruthy();
    expect(within(drawer).getByRole('link', { name: 'Artificial Analysis' })).toBeTruthy();
  });

  it('shows neither Coding nor Agentic when the row has neither', async () => {
    open(row(), ACCOUNT.id);
    const drawer = await screen.findByRole('dialog', { name: 'Alpha Max' });
    expect(within(drawer).queryByText(/Coding/)).toBeNull();
    expect(within(drawer).queryByText(/Agentic/)).toBeNull();
  });

  it('asks for the measures of the model on the page’s account', async () => {
    const asked = open(row(), ACCOUNT.id);
    await waitFor(() => {
      expect(asked).toHaveLength(1);
    });
    expect(asked[0]?.searchParams.get('model')).toBe('alpha-max');
    expect(asked[0]?.searchParams.get('account')).toBe(ACCOUNT.id);
  });

  it('shows the evals and the speeds, marks the account’s provider, and ages an old read', async () => {
    open(
      row(),
      ACCOUNT.id,
      modelMeasuresDto({
        openRouterIds: ['maker/alpha-max'],
        accountProvider: 'Amazon Bedrock',
        evals: [
          {
            benchmark: 'terminal',
            accuracy: 0.5,
            costPerTaskUsd: 0.25,
            measuredAt: ago(HOUR),
          },
        ],
        speeds: [
          {
            provider: 'Amazon Bedrock',
            tokensPerSecond: 77,
            latencyMs: 150,
            measuredAt: ago(HOUR),
          },
          {
            provider: 'Anthropic',
            tokensPerSecond: 44,
            latencyMs: 100,
            measuredAt: ago(72 * HOUR),
          },
        ],
        evalsMissing: null,
        speedsMissing: null,
      }),
    );
    const evals = await screen.findByRole('table', { name: 'Eval costs' });
    expect(within(evals).getByText('terminal')).toBeTruthy();
    expect(within(evals).getByText('50%')).toBeTruthy();
    expect(within(evals).getByText('$0.25')).toBeTruthy();
    expect(
      screen.getByText("OpenRouter's own evals; not the cost per task routing uses."),
    ).toBeTruthy();
    const speeds = screen.getByRole('table', { name: 'Speed by provider' });
    const bedrock = within(speeds).getByRole('row', { name: /Amazon Bedrock/ });
    expect(within(bedrock).getByText("This account's")).toBeTruthy();
    expect(within(bedrock).getByText('77')).toBeTruthy();
    const anthropic = within(speeds).getByRole('row', { name: /Anthropic/ });
    expect(within(anthropic).queryByText("This account's")).toBeNull();
    expect(within(anthropic).getByText('3 days ago')).toBeTruthy();
  });

  it('says why evals are missing when only speeds are stored, with no zero or blank', async () => {
    open(
      row(),
      null,
      modelMeasuresDto({
        openRouterIds: ['maker/alpha-max'],
        speeds: [
          {
            provider: 'Anthropic',
            tokensPerSecond: 44,
            latencyMs: null,
            measuredAt: ago(HOUR),
          },
        ],
        evalsMissing: 'OpenRouter has run no evals on this model.',
        speedsMissing: null,
      }),
    );
    expect(await screen.findByText('OpenRouter has run no evals on this model.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Eval costs' })).toBeNull();
    const speeds = screen.getByRole('table', { name: 'Speed by provider' });
    expect(within(speeds).getByText('—')).toBeTruthy();
  });

  it('says why both sections are empty, and draws no table', async () => {
    open(
      row(),
      null,
      modelMeasuresDto({ evalsMissing: 'Reason one.', speedsMissing: 'Reason two.' }),
    );
    expect(await screen.findByText('Reason one.')).toBeTruthy();
    expect(screen.getByText('Reason two.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Eval costs' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Speed by provider' })).toBeNull();
  });
});

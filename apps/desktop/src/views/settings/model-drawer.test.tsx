import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { accountDto } from '../../test/account-fixtures';
import { modelEffortDto, modelMeasuresDto, modelRowDto } from '../../test/model-fixtures';
import { ModelDrawer } from './model-drawer';

describe('the model drawer’s OpenRouter additions', () => {
  it('shows Coding and Agentic with their source when the row has them', async () => {
    server.use(
      http.get(daemonUrl('/models/measures'), () => HttpResponse.json(modelMeasuresDto())),
      ...baseHandlers(),
    );
    renderWithDaemon(
      <ModelDrawer
        row={modelRowDto({
          model: 'alpha-max',
          name: 'Alpha Max',
          efforts: [modelEffortDto({ effort: 'max', intelligence: 40, costPerTaskUsd: 1.5 })],
          coding: 52,
          agentic: 48,
          sources: {
            intelligence: 'aa_via_openrouter',
            coding: 'aa_via_openrouter',
            agentic: 'aa_via_openrouter',
            costPerTask: null,
            speed: null,
          },
        })}
        opened
        onClose={() => undefined}
        now={Date.now()}
        picks={[]}
        account={accountDto({ label: 'Work key', kind: 'bedrock' }).id}
      />,
    );
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
});

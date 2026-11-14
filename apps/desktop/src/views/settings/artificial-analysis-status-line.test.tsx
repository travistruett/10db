import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { benchmarkStatusDto } from '../../test/benchmark-fixtures';
import { baseHandlers, daemonUrl, renderWithDaemonAndRouter, server } from '../../test/daemon';
import { ArtificialAnalysisStatusLine } from './artificial-analysis-status-line';

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60_000).toISOString();

const ROWS = [
  {
    name: 'a key set and synced',
    status: { keyConfigured: true, lastSuccessAt: TWO_HOURS_AGO, outcome: 'ok' },
    line: 'Scores from Artificial Analysis · synced 2h ago',
    link: 'Manage',
  },
  {
    name: 'a key set and not yet synced',
    status: { keyConfigured: true },
    line: 'Scores from Artificial Analysis · not synced yet',
    link: 'Manage',
  },
  {
    name: 'a key set and a sync running',
    status: { keyConfigured: true, syncing: true },
    line: 'Scores from Artificial Analysis · syncing',
    link: 'Manage',
  },
  {
    name: 'no key',
    status: { keyConfigured: false },
    line: 'No Artificial Analysis key: models are compared without scores',
    link: 'Add Key',
  },
  {
    name: 'a daemon started with benchmarks off',
    status: { off: true },
    line: 'Artificial Analysis is off: 10db was started with TENDB_BENCHMARKS=off',
    link: null,
  },
] as const;

describe('the Models page status line for Artificial Analysis', () => {
  it.each(ROWS)('says the state for $name', async ({ status, line, link }) => {
    server.use(
      http.get(daemonUrl('/benchmarks/status'), () =>
        HttpResponse.json(benchmarkStatusDto(status)),
      ),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<ArtificialAnalysisStatusLine />);
    expect((await screen.findByText(line, { exact: false })).textContent).toContain(line);
    if (link === null) expect(screen.queryByRole('link')).toBeNull();
    else {
      const anchor = screen.getByRole('link', { name: link });
      expect(anchor.getAttribute('href')).toBe('/settings/integrations?focus=artificial-analysis');
    }
  });

  it('says it could not read the status, rather than a state it does not know', async () => {
    server.use(
      http.get(daemonUrl('/benchmarks/status'), () => new HttpResponse(null, { status: 500 })),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<ArtificialAnalysisStatusLine />);
    await waitFor(() => {
      expect(screen.getByText('The Artificial Analysis status could not be read.')).toBeTruthy();
    });
    expect(screen.queryByRole('link')).toBeNull();
  });
});

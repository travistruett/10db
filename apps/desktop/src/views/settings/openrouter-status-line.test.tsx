import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { benchmarkStatusDto } from '../../test/benchmark-fixtures';
import { baseHandlers, daemonUrl, renderWithDaemonAndRouter, server } from '../../test/daemon';
import { OpenRouterStatusLine } from './openrouter-status-line';

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
const LINK_HREF = '/settings/decisions?focus=paid-by';
const OFF_WORDS =
  "OpenRouter isn't read while 10db runs with TENDB_JUDGE=off or TENDB_BENCHMARKS=off.";

const openRouter = (over: Record<string, unknown>) => ({
  keyConfigured: true,
  lastSuccessAt: null,
  outcome: null,
  message: null,
  off: false,
  ...over,
});

const ROWS = [
  {
    name: 'ok',
    status: {
      openRouter: openRouter({ outcome: 'ok', lastSuccessAt: TWO_HOURS_AGO }),
      keyConfigured: true,
    },
    line: 'Speed and more scores from OpenRouter · read 2 hours ago',
    link: null,
  },
  {
    name: 'ok with no Artificial Analysis key',
    status: {
      openRouter: openRouter({ outcome: 'ok', lastSuccessAt: TWO_HOURS_AGO }),
      keyConfigured: false,
    },
    line: 'Scores at max effort only, from Artificial Analysis through OpenRouter, and speed · read 2 hours ago',
    link: null,
  },
  {
    name: 'no key',
    status: { openRouter: openRouter({ keyConfigured: false, outcome: 'no_key' }) },
    line: 'Add an OpenRouter account for measured speed and more scores',
    link: 'Paid by',
  },
  {
    name: 'a key not read yet',
    status: { openRouter: openRouter({}) },
    line: 'Reading OpenRouter…',
    link: null,
  },
  {
    name: 'unauthorized',
    status: { openRouter: openRouter({ outcome: 'unauthorized' }) },
    line: 'OpenRouter refused the key of the account decisions are paid by.',
    link: 'Paid by',
  },
  {
    name: 'failed',
    status: { openRouter: openRouter({ outcome: 'failed', message: 'OpenRouter answered 500' }) },
    line: 'OpenRouter answered 500',
    link: null,
  },
  {
    name: 'rate limited',
    status: { openRouter: openRouter({ outcome: 'rate_limited', message: 'Wait a minute' }) },
    line: 'Wait a minute',
    link: null,
  },
  {
    name: 'off',
    status: { openRouter: openRouter({ off: true, keyConfigured: false }) },
    line: OFF_WORDS,
    link: null,
  },
] as const;

describe('the Models page status line for OpenRouter', () => {
  it.each(ROWS)('says the state for $name', async ({ status, line, link }) => {
    server.use(
      http.get(daemonUrl('/benchmarks/status'), () =>
        HttpResponse.json(benchmarkStatusDto(status)),
      ),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<OpenRouterStatusLine />);
    expect((await screen.findByText(line, { exact: false })).textContent).toContain(line);
    if (link === null) expect(screen.queryByRole('link')).toBeNull();
    else expect(screen.getByRole('link', { name: link }).getAttribute('href')).toBe(LINK_HREF);
  });
});

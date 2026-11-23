import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { daemonUrl, renderApp, server } from '../../test/daemon';
import { serveJudge } from '../../test/judge-fixtures';

describe('Settings › Decisions', () => {
  it('says these are 10db’s own judgement calls and points to Knowledge for recorded decisions', async () => {
    serveJudge({});
    server.use(http.get(daemonUrl('/accounts'), () => HttpResponse.json([DEFAULT_ACCOUNT])));
    renderApp('/settings/decisions');
    expect(await screen.findByText(/Routine calls 10db makes with a fast model/)).toBeTruthy();
    const link = within(screen.getByRole('main')).getByRole('link', { name: 'Knowledge' });
    expect(link.getAttribute('href')).toBe('/knowledge');
  });
});

import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { daemonUrl, renderApp, server } from '../../test/daemon';
import { serveJudge } from '../../test/judge-fixtures';

describe('Settings › Decisions', () => {
  it('says what the page is for, and its guide points to Knowledge for recorded decisions', async () => {
    serveJudge({});
    server.use(http.get(daemonUrl('/accounts'), () => HttpResponse.json([DEFAULT_ACCOUNT])));
    renderApp('/settings/decisions');
    expect(await screen.findByText(/Small calls 10db makes many times a day/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'How decisions work' }));
    expect(await screen.findByText(/Ones you record yourself are in Knowledge/)).toBeTruthy();
  });
});

import { SystemCheckDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../test/daemon';
import { useRecheckSystem, useSystemCheck } from './queries';

const check = (signedIn: string | null) =>
  SystemCheckDto.parse({
    loginEnv: { source: 'login_shell', warning: null },
    claudeCode: { verifiedOn: '2.1.302', warning: null },
    tools: [{ name: 'gh', path: '/usr/bin/gh', version: 'gh 2.0.0', required: false, signedIn }],
  });

function Gh() {
  const system = useSystemCheck();
  const recheck = useRecheckSystem();
  const login = system.data?.tools.find((t) => t.name === 'gh')?.signedIn;
  return (
    <>
      <p>{login === undefined ? 'loading' : (login ?? 'signed out')}</p>
      <button
        onClick={() => {
          recheck.mutate();
        }}
      >
        recheck
      </button>
    </>
  );
}

describe('useRecheckSystem', () => {
  it('fetches with recheck=1 and writes the result into the system query', async () => {
    const queries: string[] = [];
    server.use(
      http.get(daemonUrl('/system'), ({ request }) => {
        const recheck = new URL(request.url).searchParams.get('recheck');
        queries.push(recheck ?? '');
        return HttpResponse.json(check(recheck === '1' ? 'octocat' : null));
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(<Gh />);
    await screen.findByText('signed out');
    fireEvent.click(screen.getByRole('button', { name: 'recheck' }));
    await screen.findByText('octocat');
    await waitFor(() => {
      expect(queries).toEqual(['', '1']);
    });
  });
});

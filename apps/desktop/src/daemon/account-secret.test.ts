import { AccountDto } from '@10db/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { accountDto } from '../test/account-fixtures';
import { daemonUrl, server, TEST_CONNECTION } from '../test/daemon';
import { createDaemonClient } from './client';
import { sendAccountSecret } from './account-secret';

describe('sendAccountSecret', () => {
  it('puts the secret to the account with the bearer token and parses the answer', async () => {
    const account = accountDto({ kind: 'gateway', secretSet: true });
    const seen: { path: string; auth: string | null; body: unknown }[] = [];
    server.use(
      http.put(daemonUrl('/accounts/:accountId/secret'), async ({ request, params }) => {
        seen.push({
          path: String(params['accountId']),
          auth: request.headers.get('authorization'),
          body: await request.json(),
        });
        return HttpResponse.json(account);
      }),
    );
    const result = await sendAccountSecret(createDaemonClient(TEST_CONNECTION), account.id, {
      secret: 'pasted-value-never-echoed',
    });
    expect(seen).toEqual([
      {
        path: account.id,
        auth: 'Bearer test-token',
        body: { secret: 'pasted-value-never-echoed' },
      },
    ]);
    expect(result).toEqual(AccountDto.parse(account));
  });
});

import { AccountId } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import {
  accountPauseDto,
  accountSignInDto,
  accountUsageDto,
  DEFAULT_ACCOUNT,
} from '../../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';
import { formatMoment } from './account-pause';

it('shows the account’s pause with a Resume that lifts a refusal', async () => {
  const pause = accountPauseDto({ accountId: DEFAULT_ACCOUNT.id, reason: 'refused' });
  const resumes: string[] = [];
  server.use(
    http.get(daemonUrl('/accounts/:accountId/usage'), ({ params }) =>
      HttpResponse.json(accountUsageDto({ accountId: AccountId.parse(params['accountId']) })),
    ),
    http.get(daemonUrl('/accounts/pauses'), () => HttpResponse.json([pause])),
    http.post(daemonUrl('/accounts/:accountId/resume'), ({ params }) => {
      resumes.push(String(params['accountId']));
      return HttpResponse.json([]);
    }),
    http.get(daemonUrl('/accounts/:accountId/signin'), ({ params }) =>
      HttpResponse.json(accountSignInDto({ accountId: AccountId.parse(params['accountId']) })),
    ),
    http.get(daemonUrl('/accounts/connecting'), () => HttpResponse.json(null)),
    ...baseHandlers(),
  );
  renderApp('/settings/accounts');
  const table = await screen.findByRole('table', { name: 'Accounts' });
  fireEvent.click(await within(table).findByRole('button', { name: 'Open Claude plan' }));
  const dialog = await screen.findByRole('dialog', {
    name: (name) => name.startsWith('Claude plan'),
  });
  expect(await within(dialog).findByText(/Sessions Refused/)).toBeTruthy();
  expect(within(dialog).getByText(new RegExp(`since ${formatMoment(pause.since)}`))).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Resume Claude plan' }));
  await waitFor(() => {
    expect(resumes).toEqual([DEFAULT_ACCOUNT.id]);
  });
});

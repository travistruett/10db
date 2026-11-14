import { JudgeDecision, type AccountDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { accountDto, DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { judgeKeys } from '../../daemon/judge-queries';
import { daemonUrl, renderApp, server } from '../../test/daemon';
import { decisionStatsDto, judgeStatusDto, serveJudge } from '../../test/judge-fixtures';

function open(options: Parameters<typeof serveJudge>[0] = {}) {
  const sent = serveJudge(options);
  // The accounts the judge can resolve are the ones Accounts lists, besides the default plan.
  server.use(
    http.get(daemonUrl('/accounts'), () =>
      HttpResponse.json([DEFAULT_ACCOUNT, ...(options.accounts ?? [])]),
    ),
  );
  const app = renderApp('/settings/decisions');
  return { sent, ...app };
}

describe('Settings › Decisions', () => {
  it('says these are 10db’s own judgement calls and points to Knowledge for recorded decisions', async () => {
    open();
    expect(await screen.findByText(/routine calls 10db makes with a fast model/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Knowledge' });
    expect(link.getAttribute('href')).toBe('/knowledge');
  });

  describe('Decisions table', () => {
    const noKey = judgeStatusDto();
    const rowOf = async (label: string) => {
      const button = await screen.findByRole('button', { name: label });
      const row = button.closest('tr');
      if (row === null) throw new Error(`no row for ${label}`);
      return row;
    };
    const keyed = () => {
      const work = accountDto({ kind: 'openrouter', label: 'Work key', secretSet: true });
      return {
        work,
        status: judgeStatusDto({
          config: { ...judgeStatusDto().config, accountId: work.id },
          account: { id: work.id, label: work.label, secretSet: true, secretState: 'set' },
        }),
      };
    };

    it('still shows the Status column in Settings › Decisions', async () => {
      open();
      const table = await screen.findByRole('table', { name: 'Decisions' });
      expect(within(table).getByRole('columnheader', { name: 'Status' })).toBeTruthy();
    });

    it('groups every decision, with no Sizing group until it has rows', async () => {
      open();
      await screen.findByRole('table', { name: 'Decisions' });
      const groups = screen.getAllByRole('rowheader').map((h) => h.textContent);
      expect(groups).toEqual(['Delivery', 'Plan', 'Stakeholder questions']);
      expect(screen.queryByText('Sizing', { selector: 'th' })).toBeNull();
    });

    it('each row shows its status, model, sure enough and last 30 days', async () => {
      const { work, status } = keyed();
      open({
        status,
        accounts: [work],
        stats: {
          since: '2026-10-14T12:00:00.000Z',
          decisions: [
            decisionStatsDto(JudgeDecision.ReviewSize, { calls: 120, acted: 62, costUsd: 0.0123 }),
          ],
        },
      });
      const row = await rowOf('Skip review for small changes');
      await waitFor(() => {
        expect(row.textContent).toContain('120 calls · 62 acted · $0.0123');
      });
      expect(row.textContent).toContain('Acting');
      expect(row.textContent).not.toContain('no key');
      await waitFor(() => {
        expect(row.textContent).toContain('Jev 1.13');
      });
      expect(row.textContent).toContain('80%');
    });

    it('a decision with no calls in 30 days reads No calls', async () => {
      open({
        stats: {
          since: '2026-10-14T12:00:00.000Z',
          decisions: [decisionStatsDto(JudgeDecision.ReviewSize, { calls: 3 })],
        },
      });
      const row = await rowOf('Which option a conversation chose');
      await waitFor(() => {
        expect(row.textContent).toContain('No calls');
      });
      expect(row.textContent).not.toContain('—');
    });

    it('with no key every status says so', async () => {
      open({ status: noKey });
      const row = await rowOf('Who a question goes to');
      expect(row.textContent).toContain('Acting');
      expect(row.textContent).toContain('· no key');
      expect(row.textContent).toContain('jev-1.13');
    });

    it.each([
      ['the master switch is off', { enabled: false }, false],
      ['the daemon runs with the judge off', {}, true],
    ] as const)('every status reads Off (all decisions) while %s', async (_name, config, off) => {
      open({
        status: judgeStatusDto({ config: { ...judgeStatusDto().config, ...config }, off }),
      });
      await screen.findByRole('table', { name: 'Decisions' });
      for (const label of [
        'Skip review for small changes',
        'Enough to propose',
        'Whether a reply approves',
      ]) {
        expect((await rowOf(label)).textContent).toContain('Off (all decisions)');
      }
    });

    it('a stats failure still lists every decision, with a dash', async () => {
      const { queryClient } = open();
      server.use(
        http.get(daemonUrl('/judge/decisions'), () =>
          HttpResponse.json({ message: 'down' }, { status: 500 }),
        ),
      );
      const row = await rowOf('Which question a reply answers');
      await waitFor(() => {
        expect(queryClient.getQueryState(judgeKeys.decisions)?.status).toBe('error');
      });
      expect(row.textContent).toContain('—');
      expect(row.textContent).not.toContain('No calls');
      expect(screen.getAllByRole('row').length).toBeGreaterThan(8);
    });

    it('says no key only while decisions are on', async () => {
      open({ status: judgeStatusDto({ config: { ...judgeStatusDto().config, enabled: false } }) });
      const row = await rowOf('Who a question goes to');
      expect(row.textContent).toContain('Off (all decisions)');
      expect(row.textContent).not.toContain('no key');
    });

    it('puts the master switch’s line under it', async () => {
      open();
      expect(
        await screen.findByText(
          'When off, 10db makes every decision the way it did before and never calls OpenRouter.',
        ),
      ).toBeTruthy();
    });

    it('Paid by sits beside the master switch', async () => {
      const { work, status } = keyed();
      open({ status, accounts: [work] });
      expect(await screen.findByRole('combobox', { name: 'Paid by' })).toBeTruthy();
      expect(screen.getByRole('switch', { name: 'Fast-model decisions' })).toBeTruthy();
      expect(screen.queryByText('Runs on')).toBeNull();
    });

    it('a row, or its name button, opens that decision', async () => {
      open();
      const row = await rowOf('Who a question goes to');
      fireEvent.click(within(row).getByText('jev-1.13'));
      expect(await screen.findByRole('dialog', { name: 'Who a question goes to' })).toBeTruthy();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Who a question goes to' })).toBeNull();
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Whether a reply approves' }));
      expect(await screen.findByRole('dialog', { name: 'Whether a reply approves' })).toBeTruthy();
    });
  });

  describe('Paid by', () => {
    const router = (label: string, secretSet = true) =>
      accountDto({ kind: 'openrouter', label, secretSet });
    const status = (account: AccountDto, secretState: 'set' | 'missing' | 'changed' = 'set') =>
      judgeStatusDto({
        config: { ...judgeStatusDto().config, accountId: account.id },
        account: {
          id: account.id,
          label: account.label,
          secretSet: secretState === 'set',
          secretState,
        },
      });

    it('asks for an OpenRouter account when there is none, and opens Add Account on that kind', async () => {
      open();
      expect(await screen.findByText('No account can run decisions yet.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Add OpenRouter Account' }));
      const dialog = await screen.findByRole('dialog', { name: 'Add Account' });
      expect(within(dialog).getByRole('combobox', { name: 'Kind' })).toHaveProperty(
        'value',
        'OpenRouter key',
      );
      expect(within(dialog).getByLabelText('OpenRouter key', { selector: 'input' })).toBeTruthy();
    });

    it('says the accounts could not be read, instead of asking for an account', async () => {
      open();
      server.use(
        http.get(daemonUrl('/accounts'), () =>
          HttpResponse.json({ message: 'down' }, { status: 500 }),
        ),
      );
      expect(await screen.findByText(/Accounts could not be loaded/)).toBeTruthy();
      expect(screen.queryByText('No account can run decisions yet.')).toBeNull();
    });

    it('shows the account decisions run on with its key set, and no key row or Test', async () => {
      const work = router('Work key');
      open({ status: status(work), accounts: [work] });
      const select = await screen.findByRole('combobox', { name: 'Paid by' });
      await waitFor(() => {
        expect(select).toHaveProperty('value', 'Work key');
      });
      expect(screen.getByText('Key set')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'View account' }).getAttribute('href')).toBe(
        `/settings/accounts?focus=${work.id}`,
      );
      expect(screen.getByTestId('connection-dot').getAttribute('data-color')).toBe('teal');
      expect(screen.queryByRole('button', { name: /Set Key|Replace Key|Remove Key/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Test Connection' })).toBeNull();
    });

    it.each([
      { name: 'missing', secretState: 'missing', text: 'No key' },
      { name: 'changed outside 10db', secretState: 'changed', text: 'Key changed outside 10db' },
    ] as const)('says the key is $name and links to the account', async ({ secretState, text }) => {
      const work = router('Work key', false);
      open({ status: status(work, secretState), accounts: [work] });
      expect(await screen.findByText(text)).toBeTruthy();
      expect(screen.getByTestId('connection-dot').getAttribute('data-color')).toBe('yellow');
      expect(
        screen.getByRole('link', { name: 'Set the key again in Accounts' }).getAttribute('href'),
      ).toBe(`/settings/accounts?focus=${work.id}`);
    });

    it('lists the other kinds disabled with their reason and sends the OpenRouter account picked', async () => {
      const work = router('Work key');
      const spare = router('Spare');
      const { sent } = open({ status: status(work), accounts: [work, spare] });
      const select = await screen.findByRole('combobox', { name: 'Paid by' });
      fireEvent.click(select);
      const plan = await screen.findByRole('option', { name: /Claude plan/, hidden: true });
      expect(
        plan.getAttribute('aria-disabled') ?? plan.getAttribute('data-combobox-disabled'),
      ).toBeTruthy();
      expect(within(plan).getByText('Decisions run on OpenRouter for now')).toBeTruthy();
      fireEvent.click(await screen.findByRole('option', { name: /Spare/, hidden: true }));
      await waitFor(() => {
        expect(sent).toContainEqual({
          method: 'PATCH',
          path: '/judge',
          body: { accountId: spare.id },
        });
      });
    });
  });

  it('says the daemon runs with the judge off and disables the controls', async () => {
    open({ status: judgeStatusDto({ off: true }) });
    expect(await screen.findByText(/TENDB_JUDGE=off/)).toBeTruthy();
    // Adding the account is still possible: it is what a later start without the switch will use.
    expect(await screen.findByRole('button', { name: 'Add OpenRouter Account' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByRole('switch', { name: 'Fast-model decisions' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('says when there are no decisions yet', async () => {
    open();
    expect(await screen.findByText('No decisions yet.')).toBeTruthy();
  });
});

describe('Settings › Decisions › Plan measures', () => {
  it('has no Sizing or Questions: they sit in Plan’s view', async () => {
    open();
    await screen.findByRole('table', { name: 'Decisions' });
    expect(screen.queryByRole('group', { name: 'Sizing' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Questions' })).toBeNull();
  });
});

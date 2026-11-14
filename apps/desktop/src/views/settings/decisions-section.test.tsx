import type { AccountDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { accountDto, DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { daemonUrl, renderApp, server } from '../../test/daemon';
import {
  decisionModelDto,
  judgeStatusDto,
  serveJudge,
  shapeMeasuresDto,
} from '../../test/judge-fixtures';

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

  describe('Runs on', () => {
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
      const select = await screen.findByRole('combobox', { name: 'Runs on' });
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
      const select = await screen.findByRole('combobox', { name: 'Runs on' });
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

  it('sends the master switch and the per-decision switch as patches', async () => {
    const { sent } = open();
    const master = await screen.findByRole('switch', {
      name: 'Use fast models for routine decisions',
    });
    expect(master).toHaveProperty('checked', true);
    fireEvent.click(master);
    await waitFor(() => {
      expect(sent).toContainEqual({ method: 'PATCH', path: '/judge', body: { enabled: false } });
    });
    fireEvent.click(
      screen.getByRole('switch', { name: 'Skip review for small, well-tested changes' }),
    );
    await waitFor(() => {
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/judge',
        body: { decisions: { review_size: { enabled: false } } },
      });
    });
  });

  it('sends a changed floor', async () => {
    const { sent } = open();
    const floor = await screen.findByLabelText('Confidence needed');
    expect(floor).toHaveProperty('value', '0.8');
    fireEvent.change(floor, { target: { value: '0.9' } });
    fireEvent.blur(floor);
    await waitFor(() => {
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/judge',
        body: { decisions: { review_size: { floor: 0.9 } } },
      });
    });
  });

  describe('Model', () => {
    const work = accountDto({ kind: 'openrouter', label: 'Work key', secretSet: true });
    const keyed = judgeStatusDto({
      config: { ...judgeStatusDto().config, accountId: work.id },
      account: { id: work.id, label: work.label, secretSet: true, secretState: 'set' },
    });
    const models = [
      decisionModelDto(),
      decisionModelDto({
        id: '~typesafe/jev-latest',
        name: 'Jev Latest',
        latest: true,
      }),
      decisionModelDto({
        id: 'respan/span-01-lite:free',
        name: 'Span 01 Lite (free)',
        maker: 'Respan',
        inputUsdPerMillion: 0,
      }),
      decisionModelDto({
        id: 'cloudflare/clairic',
        name: 'Clairic',
        maker: 'Cloudflare',
        inputUsdPerMillion: 0.1,
        cantCall:
          "10db can't call this model yet: OpenRouter serves it for extractions, not decisions.",
      }),
    ];

    it("lists OpenRouter's decision models with their price, the latest and the ones 10db can't call", async () => {
      open({ status: keyed, accounts: [work], models });
      const select = await screen.findByRole('combobox', { name: 'Model' });
      await waitFor(() => {
        expect(select).toHaveProperty('value', 'Jev 1.13');
      });
      fireEvent.click(select);
      const latest = await screen.findByRole('option', { name: /Jev Latest/, hidden: true });
      expect(
        within(latest).getByText(/Always TypeSafe's newest · \$0\.042 per million input tokens/),
      ).toBeTruthy();
      const free = screen.getByRole('option', { name: /Span 01 Lite/, hidden: true });
      expect(within(free).getByText(/respan\/span-01-lite:free · Free/)).toBeTruthy();
      const clairic = screen.getByRole('option', { name: /Clairic/, hidden: true });
      expect(
        clairic.getAttribute('aria-disabled') ?? clairic.getAttribute('data-combobox-disabled'),
      ).toBeTruthy();
      expect(within(clairic).getByText(/can't call this model yet/)).toBeTruthy();
    });

    it('sends the model picked, which the daemon saves once it answers a test decision', async () => {
      const { sent } = open({ status: keyed, accounts: [work], models });
      fireEvent.click(await screen.findByRole('combobox', { name: 'Model' }));
      fireEvent.click(await screen.findByRole('option', { name: /Jev Latest/, hidden: true }));
      await waitFor(() => {
        expect(sent).toContainEqual({
          method: 'PATCH',
          path: '/judge',
          body: { decisions: { review_size: { model: '~typesafe/jev-latest' } } },
        });
      });
      // Saved, not only shown while it is tested: the field is enabled again and still shows the pick.
      await waitFor(() => {
        expect(screen.queryByText(/a test decision…/)).toBeNull();
        const select = screen.getByRole('combobox', { name: 'Model' });
        expect(select).toHaveProperty('disabled', false);
        expect(select).toHaveProperty('value', 'Jev Latest');
      });
    });

    it('keeps the saved model in view and offers Try Again when the list cannot be read', async () => {
      open({ status: keyed, accounts: [work], models });
      let failing = true;
      server.use(
        http.get(daemonUrl('/judge/models'), () =>
          failing
            ? HttpResponse.json({ error: 'upstream', message: 'HTTP 503' }, { status: 502 })
            : HttpResponse.json({ models, fetchedAt: '2026-11-13T12:00:00.000Z' }),
        ),
      );
      expect(await screen.findByText(/could not be read/)).toBeTruthy();
      expect(screen.getByText('typesafe/jev-1.13')).toBeTruthy();
      failing = false;
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
      expect(await screen.findByRole('combobox', { name: 'Model' })).toBeTruthy();
    });

    it('says why a model was refused and keeps the one saved', async () => {
      open({
        status: keyed,
        accounts: [work],
        models,
        refuseModel:
          "~typesafe/jev-latest didn't answer a test decision, so it wasn't saved: OpenRouter answered HTTP 400",
      });
      fireEvent.click(await screen.findByRole('combobox', { name: 'Model' }));
      fireEvent.click(await screen.findByRole('option', { name: /Jev Latest/, hidden: true }));
      expect(await screen.findByText(/didn't answer a test decision/)).toBeTruthy();
      expect(screen.getByRole('combobox', { name: 'Model' })).toHaveProperty('value', 'Jev 1.13');
    });

    it("says so when the saved model is one 10db can't call", async () => {
      const saved = judgeStatusDto({
        ...keyed,
        config: {
          ...keyed.config,
          decisions: {
            ...keyed.config.decisions,
            review_size: { enabled: true, model: 'cloudflare/clairic', floor: 0.8 },
          },
        },
      });
      open({ status: saved, accounts: [work], models });
      // Beside the field, not only in its closed list's option.
      await waitFor(() => {
        const beside = screen
          .getAllByText(/OpenRouter serves it for extractions/)
          .filter((el) => el.closest('[role="option"]') === null);
        expect(beside).toHaveLength(1);
      });
    });

    it('asks for a key instead of listing models when there is none', async () => {
      open();
      expect(await screen.findByText('typesafe/jev-1.13')).toBeTruthy();
      expect(screen.getByText(/Add an OpenRouter key to pick another model/)).toBeTruthy();
      expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
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
    expect(
      screen.getByRole('switch', { name: 'Use fast models for routine decisions' }),
    ).toHaveProperty('disabled', true);
  });

  it('says when there are no decisions yet', async () => {
    open();
    expect(await screen.findByText('No decisions yet.')).toBeTruthy();
  });
});

describe('Settings › Decisions › Shape (spec §8, §9)', () => {
  it('shows the Sizing hit rate with n, per bucket, and overrides beside it', async () => {
    open({
      measures: shapeMeasuresDto({
        sizing: {
          n: 5,
          within: 4,
          buckets: {
            S: { n: 2, within: 2 },
            M: { n: 3, within: 2 },
            L: { n: 0, within: 0 },
            XL: { n: 0, within: 0 },
          },
          overrides: 1,
        },
      }),
    });
    const sizing = await screen.findByRole('group', { name: 'Sizing' });
    expect(sizing.textContent).toContain('80% within one bucket (4 of 5)');
    expect(sizing.textContent).toContain('S 2 of 2');
    expect(sizing.textContent).toContain('M 2 of 3');
    expect(sizing.textContent).toContain('1 set by you, not counted');
  });

  it('says Sizing has nothing to measure until a converted task finishes', async () => {
    open();
    const sizing = await screen.findByRole('group', { name: 'Sizing' });
    expect(sizing.textContent).toContain('No converted task has finished yet');
  });

  it("shows Inbox question cards per converted task against the project's other tasks (spec §7)", async () => {
    open({
      measures: shapeMeasuresDto({
        questions: { converted: { tasks: 4, cards: 2 }, other: { tasks: 10, cards: 9 } },
      }),
    });
    const questions = await screen.findByRole('group', { name: 'Questions' });
    expect(questions.textContent).toContain('0.5 question cards per task (4 tasks) converted');
    expect(questions.textContent).toContain(
      "0.9 question cards per task (10 tasks) for the project's other tasks",
    );
  });

  it('says Questions has nothing to measure until a converted task starts', async () => {
    open();
    const questions = await screen.findByRole('group', { name: 'Questions' });
    expect(questions.textContent).toContain('No converted task has started yet');
  });

  it("shows each Shape decision's shadow agreement, and sends its switch", async () => {
    const { sent } = open({
      measures: shapeMeasuresDto({
        shadow: [
          { decision: 'shape_ready', answered: 3, scored: 2, agreed: 1, canShow: false },
          { decision: 'shape_record', answered: 25, scored: 20, agreed: 18, canShow: true },
          { decision: 'shape_elsewhere', answered: 0, scored: 0, agreed: 0, canShow: false },
        ],
      }),
    });
    const record = await screen.findByRole('group', { name: 'Record as a decision?' });
    expect(record.textContent).toContain('In shadow: 18 of 20 scored answers agreed (90%)');
    expect(record.textContent).toContain('Ready to show');
    const ready = screen.getByRole('group', { name: 'Enough to propose' });
    expect(screen.getByText(/until the first Propose: have you said enough\?/)).toBeTruthy();
    expect(ready.textContent).toContain('1 of 2 scored answers agreed (50%)');
    const elsewhere = screen.getByRole('group', { name: 'Question for someone else?' });
    expect(elsewhere.textContent).toContain('No scored answers yet');
    fireEvent.click(within(record).getByRole('switch'));
    await waitFor(() => {
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/judge',
        body: { decisions: { shape_record: { enabled: false } } },
      });
    });
  });
});

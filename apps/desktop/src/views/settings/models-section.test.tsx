import {
  AccountId,
  mintId,
  type AccountDto,
  type AccountModelDto,
  type CatalogueStatusDto,
  type ModelProfileDto,
  type ModelRowDto,
} from '@10db/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountDto, DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { benchmarkStatusDto } from '../../test/benchmark-fixtures';
import { baseHandlers, daemonUrl, renderWithDaemonAndRouter, server } from '../../test/daemon';
import {
  accountModelDto,
  catalogueStatusDto,
  modelEffortDto,
  modelProfileDto,
  modelRowDto,
  rolePickDto,
  rolePicksDto,
} from '../../test/model-fixtures';
import { ModelsSection } from './models-section';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const SUBSCRIPTION = DEFAULT_ACCOUNT;
const KEYED: AccountDto = accountDto({ label: 'Work key', kind: 'anthropic_api_key' });

const FAST = modelRowDto({
  model: 'alpha-fast',
  name: 'Alpha Fast',
  tier: 'efficient',
  availableOn: [SUBSCRIPTION.id, KEYED.id],
  inputPrice: 1,
  outputPrice: 5,
  intelligence: 31.5,
  outputTokensPerSecond: 180,
  stepsRun: 4,
  firstSeenAt: '2026-09-01T10:00:00.000Z',
});
const STRONG = modelRowDto({
  model: 'alpha-max',
  name: 'Alpha Max',
  tier: 'capable',
  availableOn: [SUBSCRIPTION.id, KEYED.id],
  inputPrice: 5,
  outputPrice: 25,
  intelligence: 60,
  costPerTaskUsd: 2.5,
  efforts: [
    modelEffortDto({
      effort: 'high',
      intelligence: 60,
      costPerTaskUsd: 2.5,
      stepsRun: 8,
      firstPassSteps: 6,
    }),
    modelEffortDto({
      effort: 'low',
      intelligence: 50,
      costPerTaskUsd: 0.4,
      stepsRun: 4,
      firstPassSteps: 1,
    }),
  ],
  outputTokensPerSecond: 40,
  stepsRun: 12,
  firstSeenAt: '2026-11-05T10:00:00.000Z',
});
const UNKNOWN = modelRowDto({
  model: 'house-model',
  tier: null,
  status: 'unknown',
  maker: null,
  family: null,
  availableOn: [SUBSCRIPTION.id],
  // The highest score of the list, so only the Unknown rule can put it last.
  intelligence: 99,
});
const BLANK = modelRowDto({
  model: 'beta-plain',
  name: 'Beta Plain',
  tier: 'balanced',
  availableOn: [SUBSCRIPTION.id],
});

const [STRONG_HIGH] = STRONG.efforts;
const PICKS = [
  rolePickDto({
    role: 'plan',
    need: 45,
    profileId: STRONG_HIGH?.profileId ?? null,
    model: 'alpha-max',
    effort: 'high',
    intelligence: 60,
    costPerTaskUsd: 2.5,
    reason: 'by score: cheapest profile at or above 45 intelligence',
  }),
  rolePickDto({
    role: 'implement',
    need: 40,
    profileId: STRONG_HIGH?.profileId ?? null,
    model: 'alpha-max',
    effort: 'high',
    intelligence: 60,
    costPerTaskUsd: 2.5,
  }),
  rolePickDto({
    role: 'review',
    need: 48,
    profileId: mintId('ModelProfile'),
    model: 'alpha-fast',
    effort: 'low',
    intelligence: 30,
    costPerTaskUsd: 0.2,
  }),
  rolePickDto({
    role: 'qa',
    need: 35,
    reason: 'No profile reaches 35 intelligence; a task planned on this account is refused here',
  }),
];

function serve(
  opts: {
    rows?: ModelRowDto[];
    status?: CatalogueStatusDto;
    offers?: AccountModelDto[];
    profiles?: ModelProfileDto[];
    /** The rows for a request that names an account; the account asked for is recorded in `asked`. */
    forAccount?: (account: string) => ModelRowDto[];
    asked?: (string | null)[];
    /** The accounts asked for picks; the picks answered are `PICKS` unless `accounts` is empty. */
    askedPicks?: string[];
    accounts?: AccountDto[];
  } = {},
) {
  server.use(
    http.get(daemonUrl('/models'), ({ request }) => {
      const account = new URL(request.url).searchParams.get('account');
      opts.asked?.push(account);
      return HttpResponse.json(
        account !== null && opts.forAccount
          ? opts.forAccount(account)
          : (opts.rows ?? [FAST, STRONG, UNKNOWN, BLANK]),
      );
    }),
    http.get(daemonUrl('/models/picks'), ({ request }) => {
      const account = new URL(request.url).searchParams.get('account') ?? '';
      opts.askedPicks?.push(account);
      return HttpResponse.json(rolePicksDto(AccountId.parse(account), PICKS));
    }),
    http.get(daemonUrl('/models/status'), () =>
      HttpResponse.json(opts.status ?? catalogueStatusDto()),
    ),
    http.get(daemonUrl('/models/offers'), () => HttpResponse.json(opts.offers ?? [])),
    http.get(daemonUrl('/model-profiles'), () => HttpResponse.json(opts.profiles ?? [])),
    http.get(daemonUrl('/benchmarks/status'), () => HttpResponse.json(benchmarkStatusDto())),
    http.get(daemonUrl('/accounts'), () =>
      HttpResponse.json(opts.accounts ?? [SUBSCRIPTION, KEYED]),
    ),
    ...baseHandlers(),
  );
}

/** The model names in the table, top to bottom. */
const shownNames = () =>
  screen
    .getAllByRole('button', { name: /^Open / })
    .map((b) => b.getAttribute('aria-label')?.replace('Open ', ''));

const rowOf = (name: string) => {
  const row = screen.getByRole('button', { name: `Open ${name}` }).closest('tr');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Chooses an account in the page's Account select. */
async function chooseAccount(label: string) {
  fireEvent.click(await screen.findByRole('combobox', { name: 'Account' }));
  fireEvent.click(await screen.findByRole('option', { name: label, hidden: true }));
}

describe('the Models page', () => {
  it('shows where the scores come from, beside the catalogue line', async () => {
    serve();
    await renderWithDaemonAndRouter(<ModelsSection />);
    expect(await screen.findByText(/No Artificial Analysis key/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add Key' })).toBeTruthy();
  });

  it('opens on the playbook and the kinds, above the chart and the model list', async () => {
    serve();
    await renderWithDaemonAndRouter(<ModelsSection />);
    const playbook = await screen.findByRole('region', { name: 'Playbook section' });
    const kinds = await screen.findByRole('region', { name: 'Kinds' });
    const all = await screen.findByRole('heading', { name: 'All models' });
    const chart = screen.getByRole('heading', { name: 'Intelligence and cost' });
    for (const [first, second] of [
      [playbook, kinds],
      [kinds, chart],
      [chart, all],
    ] as const)
      expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Who each role gets' })).toBeNull();
    // Each rigor's row shows what it resolves to on the account, and a role the row does not run stays blank.
    const standard = within(playbook).getByRole('row', { name: /Standard/ });
    expect(within(standard).getByText('Alpha Max')).toBeTruthy();
    // The effort and the setting share the second line, which wraps rather than truncates.
    expect(within(standard).getAllByText('high · Auto, at least 40').length).toBeGreaterThan(0);
    expect(within(standard).getAllByText(/Auto, at least 40$/)).toHaveLength(2);
    const light = within(playbook).getByRole('row', { name: /Light/ });
    expect(within(light).queryByRole('button', { name: /Light Review/ })).toBeNull();
  });

  it('drives the rows and the picks from the one Account select, the default account first', async () => {
    const asked: (string | null)[] = [];
    const askedPicks: string[] = [];
    serve({ asked, askedPicks });
    await renderWithDaemonAndRouter(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    // The playbook table reads the same list for its model names, so the account may be asked twice.
    expect([...new Set(asked)]).toEqual([SUBSCRIPTION.id]);
    // Every rigor's picks are read for the account, and no other account's.
    expect([...new Set(askedPicks)]).toEqual([SUBSCRIPTION.id]);
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveProperty(
      'value',
      'Claude plan',
    );
    await chooseAccount('Work key');
    await waitFor(() => {
      expect(asked.at(-1)).toBe(KEYED.id);
      expect(askedPicks.at(-1)).toBe(KEYED.id);
      expect(new Set(askedPicks.slice(-4))).toEqual(new Set([KEYED.id]));
    });
    // The list narrows to what the account runs.
    await waitFor(() => {
      expect(shownNames().sort()).toEqual(['Alpha Fast', 'Alpha Max']);
    });
  });

  it('lists a row per model: tier, scores, cost, the roles that use it and steps run', async () => {
    serve();
    await renderWithDaemonAndRouter(<ModelsSection />);
    const row = within(
      await screen.findByRole('button', { name: 'Open Alpha Max' }).then(() => rowOf('Alpha Max')),
    );
    expect(row.getByText('Capable')).toBeTruthy();
    // Used by lists only the roles Standard runs (Build and Review), though the pick for Plan is also this model.
    // It is plain text: violet marks a pick on the chart only.
    expect(row.getByText('Build').getAttribute('style') ?? '').not.toContain('violet');
    expect(row.queryByText(/Plan/)).toBeNull();
    for (const cell of ['60', '$2.50', '12']) {
      expect(row.getByText(cell)).toBeTruthy();
    }
    // Input, Output and Speed live in the drawer only.
    for (const title of [/Input/, /Output/, /Speed/, /Available on/])
      expect(screen.queryByRole('columnheader', { name: title })).toBeNull();
  });

  it('shows a dash where there is no data, never a zero', async () => {
    serve({ rows: [BLANK], forAccount: () => [BLANK] });
    await renderWithDaemonAndRouter(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Beta Plain' });
    const cells = within(rowOf('Beta Plain')).getAllByRole('cell');
    // Intelligence and Cost per task.
    expect(cells.slice(2, 4).map((c) => c.textContent)).toEqual(['—', '—']);
  });

  it('shows a status as dimmed text after the name, and New for a model first seen in the last seven days', async () => {
    serve();
    await renderWithDaemonAndRouter(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    expect(within(rowOf('Alpha Max')).getByText('New')).toBeTruthy();
    expect(within(rowOf('Alpha Fast')).queryByText('New')).toBeNull();
    const unknown = within(rowOf('house-model')).getByText('Unknown');
    expect(unknown.closest('.mantine-Badge-root')).toBeNull();
  });

  it('opens the drawer from a click anywhere on a row, with the effort table', async () => {
    serve();
    await renderWithDaemonAndRouter(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(within(rowOf('Alpha Max')).getByText('Capable'));
    const drawer = await screen.findByRole('dialog', { name: 'Alpha Max' });
    const efforts = within(drawer).getByRole('table', { name: 'Effort table' });
    const high = within(efforts).getByRole('row', { name: /high/ });
    expect(within(high).getByText('$2.50')).toBeTruthy();
    expect(within(high).getByText('75%')).toBeTruthy();
    const low = within(efforts).getByRole('row', { name: /low/ });
    expect(within(low).getByText('$0.40')).toBeTruthy();
    expect(within(low).getByText('25%')).toBeTruthy();
    // The header names the ID and the tier; Input, Output and Speed are one dimmed line.
    expect(within(drawer).getByText('alpha-max')).toBeTruthy();
    expect(within(drawer).getByText(/Capable tier/)).toBeTruthy();
    // The speed is its own element, so its source can be described.
    expect(
      within(drawer).getByText(
        (_, el) =>
          /^List price per 1M tokens: \$5\.00 in · \$25\.00 out · speed 40 tokens\/s$/.test(
            (el?.textContent ?? '').trim(),
          ) && el?.tagName === 'P',
      ),
    ).toBeTruthy();
    expect(within(drawer).getByRole('heading', { name: 'Offered by' })).toBeTruthy();
    // The drawer shows AA scores and speed, so it carries the credit.
    expect(within(drawer).getByRole('link', { name: 'Artificial Analysis' })).toBeTruthy();
  });

  it('opens the drawer with Enter on a name', async () => {
    serve();
    await renderWithDaemonAndRouter(<ModelsSection />);
    const name = await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(name);
    expect(await screen.findByRole('dialog', { name: 'Alpha Max' })).toBeTruthy();
  });

  it('draws the rings of the rigor chosen, Standard first', async () => {
    const asked: string[] = [];
    serve();
    server.use(
      http.get(daemonUrl('/models/picks'), ({ request }) => {
        const url = new URL(request.url);
        asked.push(url.searchParams.get('rigor') ?? '');
        return HttpResponse.json(
          rolePicksDto(AccountId.parse(url.searchParams.get('account')), PICKS),
        );
      }),
    );
    await renderWithDaemonAndRouter(<ModelsSection />);
    const rings = await screen.findByRole('combobox', { name: 'Rigor for the rings' });
    expect(rings).toHaveProperty('value', 'Standard');
    fireEvent.click(rings);
    fireEvent.click(await screen.findByRole('option', { name: 'Critical', hidden: true }));
    await waitFor(() => {
      expect(rings).toHaveProperty('value', 'Critical');
    });
    // The table reads every rigor, and the chart the one chosen: no rigor is asked twice for the account.
    await waitFor(() => {
      expect([...new Set(asked)].sort()).toEqual(['careful', 'critical', 'light', 'standard']);
    });
  });

  it('filters by tier from the Tier column, one tier or several', async () => {
    serve();
    await renderWithDaemonAndRouter(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(screen.getByRole('button', { name: 'Filter Tier' }));
    const tiers = await screen.findByRole('group', { name: 'Tier' });
    fireEvent.click(within(tiers).getByRole('checkbox', { name: 'Efficient' }));
    expect(shownNames()).toEqual(['Alpha Fast']);
    fireEvent.click(within(tiers).getByRole('checkbox', { name: 'Capable' }));
    expect(shownNames()).toEqual(['Alpha Max', 'Alpha Fast']);
    fireEvent.click(within(tiers).getByRole('checkbox', { name: 'Efficient' }));
    fireEvent.click(within(tiers).getByRole('checkbox', { name: 'Capable' }));
    expect(shownNames()).toHaveLength(4);
  });

  it('searches names and model IDs from the Model column, and says when nothing matches', async () => {
    serve();
    await renderWithDaemonAndRouter(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(screen.getByRole('button', { name: 'Filter Model' }));
    const search = await screen.findByRole('textbox', { name: 'Search models' });
    fireEvent.change(search, { target: { value: 'beta-pl' } });
    expect(shownNames()).toEqual(['Beta Plain']);
    fireEvent.change(search, { target: { value: 'nothing like it' } });
    expect(await screen.findByText('No model matches these filters.')).toBeTruthy();
  });

  it('opens sorted by Intelligence, highest first, and sorts by a column with Unknown and blanks last', async () => {
    serve();
    await renderWithDaemonAndRouter(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    expect(shownNames()).toEqual(['Alpha Max', 'Alpha Fast', 'Beta Plain', 'house-model']);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Intelligence, descending' }));
    expect(shownNames()).toEqual(['Alpha Fast', 'Alpha Max', 'Beta Plain', 'house-model']);
    expect(screen.queryByRole('button', { name: 'Sort by Tier' })).toBeNull();
  });

  it('says to add an account when there is none, and lists no rows', async () => {
    serve({ accounts: [] });
    await renderWithDaemonAndRouter(<ModelsSection />);
    const link = await screen.findByRole('link', { name: 'Add an account' });
    expect(link.getAttribute('href')).toBe('/settings/accounts');
    expect(link.parentElement?.textContent).toBe('Add an account to see what each role gets.');
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    expect(screen.getByRole('link', { name: 'Artificial Analysis' })).toBeTruthy();
  });

  it('shows the daemon’s message, not the add-an-account prompt, when the accounts cannot be read', async () => {
    serve();
    let healthy = false;
    server.use(
      http.get(daemonUrl('/accounts'), () =>
        healthy
          ? HttpResponse.json([SUBSCRIPTION, KEYED])
          : HttpResponse.json({ error: 'internal', message: 'Accounts are down' }, { status: 500 }),
      ),
    );
    await renderWithDaemonAndRouter(<ModelsSection />);
    expect((await screen.findByRole('alert')).textContent).toContain('Accounts are down');
    expect(screen.queryByText(/Add an account/)).toBeNull();
    healthy = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('button', { name: 'Open Alpha Max' })).toBeTruthy();
  });

  it('keeps a loaded page when a later read of the accounts fails, as during a daemon restart', async () => {
    serve();
    let down = false;
    server.use(
      http.get(daemonUrl('/accounts'), () =>
        down
          ? HttpResponse.json({ error: 'internal', message: 'Accounts are down' }, { status: 500 })
          : HttpResponse.json([SUBSCRIPTION, KEYED]),
      ),
    );
    const { queryClient } = await renderWithDaemonAndRouter(<ModelsSection />);
    expect(await screen.findByRole('button', { name: 'Open Alpha Max' })).toBeTruthy();
    down = true;
    await queryClient.refetchQueries({ queryKey: ['accounts'] });
    await waitFor(() => {
      expect(queryClient.getQueryState(['accounts'])?.status).toBe('error');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Open Alpha Max' })).toBeTruthy();
    expect(screen.queryByText('Accounts are down')).toBeNull();
  });

  it('shows the daemon’s message when the picks cannot be read, and Try Again reads them again', async () => {
    serve();
    let healthy = false;
    server.use(
      http.get(daemonUrl('/models/picks'), ({ request }) =>
        healthy
          ? HttpResponse.json(
              rolePicksDto(
                AccountId.parse(new URL(request.url).searchParams.get('account')),
                PICKS,
              ),
            )
          : HttpResponse.json({ error: 'internal', message: 'Picks are down' }, { status: 500 }),
      ),
    );
    await renderWithDaemonAndRouter(<ModelsSection />);
    expect((await screen.findByRole('alert')).textContent).toContain('Picks are down');
    healthy = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(
      await screen.findByRole('button', { name: /Standard Build: Alpha Max, high/ }),
    ).toBeTruthy();
  });

  it('shows the daemon’s message when the account’s models cannot be read, and Try Again reads them again', async () => {
    serve();
    let healthy = false;
    server.use(
      http.get(daemonUrl('/models'), () =>
        healthy
          ? HttpResponse.json([STRONG])
          : HttpResponse.json({ error: 'internal', message: 'The list is down' }, { status: 500 }),
      ),
    );
    await renderWithDaemonAndRouter(<ModelsSection />);
    expect((await screen.findByRole('alert')).textContent).toContain('The list is down');
    expect(screen.queryByRole('button', { name: 'Show every account' })).toBeNull();
    healthy = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('button', { name: 'Open Alpha Max' })).toBeTruthy();
  });

  it('says where the data came from and how old it is, and credits Artificial Analysis with a link', async () => {
    serve({ status: catalogueStatusDto({ fetchedAt: '2026-11-07T09:00:00.000Z', models: 40 }) });
    await renderWithDaemonAndRouter(<ModelsSection />);
    expect(await screen.findByText(/models\.dev, fetched 3 hours ago/)).toBeTruthy();
    const credit = screen.getByRole('link', { name: 'Artificial Analysis' });
    expect(credit.getAttribute('href')).toBe('https://artificialanalysis.ai/');
  });

  it.each([
    {
      name: 'a failed last attempt names the copy in use',
      status: { fetchedAt: '2026-11-07T09:00:00.000Z', lastAttempt: 'failed' as const },
      text: /Could not reach models\.dev; showing the copy from 3 hours ago/,
    },
    {
      name: 'a failed attempt with nothing to show',
      status: {
        source: 'none' as const,
        fetchedAt: null,
        models: 0,
        lastAttempt: 'failed' as const,
      },
      text: /Could not reach models\.dev, and there is no catalogue yet/,
    },
    {
      name: 'a fetch turned off',
      status: { lastAttempt: 'off' as const },
      text: /catalogue fetch is off/,
    },
  ])('$name', async ({ status, text }) => {
    serve({ status: catalogueStatusDto(status) });
    await renderWithDaemonAndRouter(<ModelsSection />);
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('says so when the catalogue status cannot be read, rather than waiting on it', async () => {
    serve();
    server.use(
      http.get(daemonUrl('/models/status'), () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    await renderWithDaemonAndRouter(<ModelsSection />);
    expect(await screen.findByText(/catalogue status could not be read/i)).toBeTruthy();
  });

  it('says there is no catalogue yet', async () => {
    serve({ status: catalogueStatusDto({ source: 'none', fetchedAt: null, models: 0 }), rows: [] });
    await renderWithDaemonAndRouter(<ModelsSection />);
    expect(await screen.findByText(/No catalogue yet/)).toBeTruthy();
  });

  it('refreshes the catalogue on demand, shows it is running, then shows the new age', async () => {
    serve({ status: catalogueStatusDto({ fetchedAt: '2026-11-07T09:00:00.000Z' }) });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posts = 0;
    server.use(
      http.post(daemonUrl('/models/refresh'), async () => {
        posts += 1;
        await gate;
        // The daemon has the newer copy by the time it answers.
        server.use(
          http.get(daemonUrl('/models/status'), () =>
            HttpResponse.json(catalogueStatusDto({ fetchedAt: '2026-11-07T11:58:00.000Z' })),
          ),
        );
        return HttpResponse.json(catalogueStatusDto({ fetchedAt: '2026-11-07T11:58:00.000Z' }));
      }),
    );
    await renderWithDaemonAndRouter(<ModelsSection />);
    expect(await screen.findByText(/fetched 3 hours ago/)).toBeTruthy();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Refresh Models' }));
    expect(
      await screen.findByText(
        "Fetch prices from models.dev and re-read every account's model list",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Models' }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Refresh Models' }).hasAttribute('data-loading'),
      ).toBe(true);
    });
    release();
    expect(await screen.findByText(/fetched 2 minutes ago/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Refresh Models' }).hasAttribute('data-loading'),
    ).toBe(false);
    expect(posts).toBe(1);
  });

  it('shows the daemon’s refusal when a refresh fails', async () => {
    serve();
    server.use(
      http.post(daemonUrl('/models/refresh'), () =>
        HttpResponse.json({ error: 'internal', message: 'The refresh broke' }, { status: 500 }),
      ),
    );
    await renderWithDaemonAndRouter(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Models' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The refresh broke');
  });

  it('marks nothing New and gives no first-seen time for a model with no profile to date it', async () => {
    const dateless = modelRowDto({
      model: 'delta-held',
      name: 'Delta Held',
      tier: null,
      status: 'not_runnable',
      availableOn: [SUBSCRIPTION.id],
      firstSeenAt: null,
    });
    serve({ rows: [dateless] });
    await renderWithDaemonAndRouter(<ModelsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Delta Held' }));
    const drawer = await screen.findByRole('dialog', { name: 'Delta Held' });
    expect(within(rowOf('Delta Held')).queryByText('New')).toBeNull();
    expect(within(drawer).queryByText(/first seen/)).toBeNull();
    // The status reads as a label, not as the raw value.
    expect(within(drawer).getByText('Not runnable')).toBeTruthy();
  });

  it('opens a drawer from a row with the accounts that offer it, each with its launch ID and own price', async () => {
    serve({
      offers: [
        accountModelDto({
          accountId: SUBSCRIPTION.id,
          model: 'alpha-max',
          launchId: 'alpha-max',
        }),
        accountModelDto({
          accountId: KEYED.id,
          model: 'alpha-max',
          launchId: 'launch.alpha-max-v1',
          inputPrice: 5.5,
          outputPrice: 27,
        }),
      ],
      profiles: [
        modelProfileDto({
          model: 'alpha-max',
          effort: 'low',
          scores: { intelligence: 50 },
          stepsRun: 4,
          firstPassSteps: 3,
          escalations: 1,
          measuredAt: '2026-11-06T12:00:00.000Z',
        }),
        modelProfileDto({
          model: 'alpha-max',
          effort: 'high',
          scores: { intelligence: 60 },
        }),
      ],
    });
    await renderWithDaemonAndRouter(<ModelsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Alpha Max' }));
    const drawer = await screen.findByRole('dialog', { name: 'Alpha Max' });
    expect(await within(drawer).findByText('launch.alpha-max-v1')).toBeTruthy();
    // How old each account's list is.
    expect(within(drawer).getByRole('columnheader', { name: 'Read' })).toBeTruthy();
    expect(within(drawer).getAllByText('a month ago').length).toBe(2);
    // A flat-rate plan is included, never $0; an account that pays per token shows its own price.
    expect(within(drawer).getByText('Included in plan')).toBeTruthy();
    expect(within(drawer).getByText('$5.50 in · $27.00 out')).toBeTruthy();
    // One line per effort, with the first-pass rate where steps ran.
    const low = within(drawer).getByRole('row', { name: /low/ });
    expect(within(low).getByText('25%')).toBeTruthy();
    const high = within(drawer).getByRole('row', { name: /high/ });
    expect(within(high).getByText('75%')).toBeTruthy();
  });

  it('says which accounts marked a model from an error’s wording, and when each mark ends', async () => {
    const inThirty = new Date(Date.now() + 30 * 60_000).toISOString();
    const tenAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    serve({
      offers: [
        accountModelDto({
          accountId: SUBSCRIPTION.id,
          model: 'alpha-max',
          unusable: true,
          wordingMarkEndsAt: inThirty,
        }),
        accountModelDto({
          accountId: KEYED.id,
          model: 'alpha-max',
          unusable: false,
          wordingMarkEndsAt: tenAgo,
        }),
      ],
    });
    await renderWithDaemonAndRouter(<ModelsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Alpha Max' }));
    const drawer = await screen.findByRole('dialog', { name: 'Alpha Max' });
    const badges = await within(drawer).findAllByText('Marked from an error’s wording');
    expect(badges).toHaveLength(2);
    const [holding, ended] = badges.map((badge) => badge.closest('tr') as HTMLElement);
    if (!holding || !ended) throw new Error('a mark is not in a row');
    expect(within(holding).getByText(SUBSCRIPTION.label)).toBeTruthy();
    expect(within(holding).getByText(/until the mark ends in 30 minutes/)).toBeTruthy();
    expect(within(holding).queryByText('Refused by this account')).toBeNull();
    expect(within(ended).getByText(KEYED.label)).toBeTruthy();
    expect(within(ended).getByText(/mark ended 10 minutes ago/)).toBeTruthy();
    expect(within(ended).getByText(/next session on it settles it/)).toBeTruthy();
  });

  it('shows a refusal from model_not_found as refused, with no wording mark or end time', async () => {
    serve({
      offers: [accountModelDto({ accountId: SUBSCRIPTION.id, model: 'alpha-max', unusable: true })],
    });
    await renderWithDaemonAndRouter(<ModelsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Alpha Max' }));
    const drawer = await screen.findByRole('dialog', { name: 'Alpha Max' });
    expect(await within(drawer).findByText('Refused by this account')).toBeTruthy();
    expect(within(drawer).queryByText('Marked from an error’s wording')).toBeNull();
    expect(within(drawer).queryByText(/until the mark ends/)).toBeNull();
  });

  it('says why a model is Unknown when an account has not listed it yet', async () => {
    const unconfirmed = modelRowDto({
      model: 'gamma-new',
      tier: null,
      status: 'unknown',
      availableOn: [SUBSCRIPTION.id, KEYED.id],
    });
    serve({
      rows: [unconfirmed],
      offers: [accountModelDto({ accountId: SUBSCRIPTION.id, model: 'other' })],
    });
    await renderWithDaemonAndRouter(<ModelsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open gamma-new' }));
    const drawer = await screen.findByRole('dialog', { name: 'gamma-new' });
    expect(
      await within(drawer).findByText(/Claude plan, Work key have not listed its models yet/),
    ).toBeTruthy();
  });

  describe('families and pages', () => {
    /** Thirty models, each the only one of its family, best first. */
    const many = Array.from({ length: 30 }, (_, i) =>
      modelRowDto({
        model: `solo-${String(i)}`,
        name: `Solo ${String(i)}`,
        family: `solo-${String(i)}`,
        availableOn: [SUBSCRIPTION.id, KEYED.id],
        intelligence: 90 - i,
      }),
    );
    const ZED = modelRowDto({
      model: 'zed-2',
      name: 'Zed 2',
      family: 'zed',
      availableOn: [SUBSCRIPTION.id],
      intelligence: 70,
    });
    const zedOld = (n: number) =>
      modelRowDto({
        model: `zed-${String(n)}`,
        name: `Zed ${String(n)}`,
        family: 'zed',
        status: 'superseded',
        availableOn: [SUBSCRIPTION.id],
        intelligence: 50 + n,
      });

    it('shows 25 families a page, and Next shows the rest', async () => {
      serve({ rows: many, forAccount: () => many });
      await renderWithDaemonAndRouter(<ModelsSection />);
      await screen.findByRole('button', { name: 'Open Solo 0' });
      expect(shownNames()).toHaveLength(25);
      expect(screen.getByText('1–25 of 30')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
      await waitFor(() => {
        expect(shownNames()).toEqual(['Solo 25', 'Solo 26', 'Solo 27', 'Solo 28', 'Solo 29']);
      });
    });

    it.each<[string, () => Promise<void>]>([
      [
        'the Model filter',
        async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Filter Model' }));
          fireEvent.change(await screen.findByRole('textbox', { name: 'Search models' }), {
            target: { value: 'solo' },
          });
        },
      ],
      [
        'the sort',
        async () => {
          fireEvent.click(
            await screen.findByRole('button', { name: 'Sort by Intelligence, descending' }),
          );
        },
      ],
      [
        'the account',
        async () => {
          await chooseAccount('Work key');
        },
      ],
    ])('goes back to the first page when %s changes', async (_case, change) => {
      serve({ rows: many, forAccount: () => many });
      await renderWithDaemonAndRouter(<ModelsSection />);
      await screen.findByRole('button', { name: 'Open Solo 0' });
      fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
      expect(await screen.findByText('26–30 of 30')).toBeTruthy();
      await change();
      expect(await screen.findByText('1–25 of 30')).toBeTruthy();
    });

    it('stays on a page that exists when a refresh shrinks the list', async () => {
      let rows = many;
      serve({ rows, forAccount: () => rows });
      const { queryClient } = await renderWithDaemonAndRouter(<ModelsSection />);
      await screen.findByRole('button', { name: 'Open Solo 0' });
      fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
      expect(await screen.findByText('26–30 of 30')).toBeTruthy();
      rows = many.slice(0, 20);
      await act(async () => {
        await queryClient.refetchQueries();
      });
      expect(await screen.findByText('1–20 of 20')).toBeTruthy();
      expect(shownNames()).toHaveLength(20);
    });

    it('nests a family’s older versions under its current model, and opening them opens no drawer', async () => {
      const rows = [ZED, zedOld(1), zedOld(0)];
      serve({ rows, forAccount: () => rows });
      await renderWithDaemonAndRouter(<ModelsSection />);
      await screen.findByRole('button', { name: 'Open Zed 2' });
      expect(shownNames()).toEqual(['Zed 2']);
      fireEvent.click(
        within(rowOf('Zed 2')).getByRole('button', { name: 'Show 2 older versions of Zed 2' }),
      );
      await screen.findByRole('button', { name: 'Open Zed 1' });
      expect(shownNames()).toEqual(['Zed 2', 'Zed 1', 'Zed 0']);
      expect(screen.queryByRole('dialog')).toBeNull();
      // The pager counts families, not the rows an open family adds.
      expect(screen.getByText('1–1 of 1')).toBeTruthy();
    });

    it('opens the drawer on an older version from its row', async () => {
      const rows = [ZED, zedOld(1)];
      serve({ rows, forAccount: () => rows });
      await renderWithDaemonAndRouter(<ModelsSection />);
      await screen.findByRole('button', { name: 'Open Zed 2' });
      fireEvent.click(
        within(rowOf('Zed 2')).getByRole('button', { name: 'Show 1 older version of Zed 2' }),
      );
      await screen.findByRole('button', { name: 'Open Zed 1' });
      fireEvent.click(within(rowOf('Zed 1')).getByText('Superseded'));
      expect(await screen.findByRole('dialog', { name: 'Zed 1' })).toBeTruthy();
    });

    it('names the roles that pick an older version', async () => {
      const oldFast = { ...FAST, status: 'superseded' as const };
      const rows = [STRONG, oldFast];
      serve({ rows, forAccount: () => rows });
      await renderWithDaemonAndRouter(<ModelsSection />);
      await screen.findByRole('button', { name: 'Open Alpha Max' });
      // Folded, the family's row says a role runs on a version under it.
      expect(within(rowOf('Alpha Max')).getByText('Review, on an older version')).toBeTruthy();
      fireEvent.click(
        within(rowOf('Alpha Max')).getByRole('button', {
          name: 'Show 1 older version of Alpha Max',
        }),
      );
      await screen.findByRole('button', { name: 'Open Alpha Fast' });
      expect(within(rowOf('Alpha Fast')).getByText('Review')).toBeTruthy();
      expect(
        within(rowOf('Alpha Max')).getByRole('button', {
          name: 'Hide 1 older version of Alpha Max',
        }),
      ).toBeTruthy();
    });
  });
});

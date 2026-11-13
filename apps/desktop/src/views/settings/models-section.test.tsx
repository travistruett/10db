import {
  AccountId,
  mintId,
  type AccountDto,
  type AccountModelDto,
  type CatalogueStatusDto,
  type ModelProfileDto,
  type ModelRowDto,
} from '@10db/contracts';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  tier: 'fast',
  availableOn: [KEYED.id],
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
  tier: 'strongest',
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
    http.get(daemonUrl('/benchmarks/status'), () => HttpResponse.json(benchmarkStatusDto())),
    http.get(daemonUrl('/models/offers'), () => HttpResponse.json(opts.offers ?? [])),
    http.get(daemonUrl('/model-profiles'), () => HttpResponse.json(opts.profiles ?? [])),
    http.get(daemonUrl('/accounts'), () =>
      HttpResponse.json(opts.accounts ?? [SUBSCRIPTION, KEYED]),
    ),
    ...baseHandlers(),
  );
}

/** The page inside a router, since its status line links to Integrations. */
const renderModels = () => renderWithDaemonAndRouter(<ModelsSection />);

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
  // The Columns menu keeps its layout in the window's storage.
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the Models page', () => {
  it('shows where the scores come from, beside the catalogue line', async () => {
    serve();
    await renderModels();
    expect(await screen.findByText(/No Artificial Analysis key/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add Key' })).toBeTruthy();
  });

  it('lists a row per model with its tier, accounts, scores, prices and speed', async () => {
    serve();
    await renderModels();
    const row = within(
      await screen.findByRole('button', { name: 'Open Alpha Max' }).then(() => rowOf('Alpha Max')),
    );
    expect(row.getByText('alpha-max')).toBeTruthy();
    expect(row.getByText('Strongest')).toBeTruthy();
    expect(row.getByText('Claude plan, Work key')).toBeTruthy();
    for (const cell of ['60', '$2.50', '$5.00', '$25.00', '12']) {
      expect(row.getByText(cell)).toBeTruthy();
    }
  });

  it('shows a dash where there is no data, never a zero', async () => {
    serve({ rows: [BLANK] });
    await renderModels();
    await screen.findByRole('button', { name: 'Open Beta Plain' });
    const cells = within(rowOf('Beta Plain')).getAllByRole('cell');
    // Intelligence, Cost per task, Input and Output.
    expect(cells.slice(3, 7).map((c) => c.textContent)).toEqual(['—', '—', '—', '—']);
  });

  it('marks an Unknown model and a model first seen in the last seven days', async () => {
    serve();
    await renderModels();
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    expect(within(rowOf('Alpha Max')).getByText('New')).toBeTruthy();
    expect(within(rowOf('Alpha Fast')).queryByText('New')).toBeNull();
    expect(within(rowOf('house-model')).getByText('Unknown')).toBeTruthy();
  });

  it('hides Speed until the Columns menu shows it, and keeps it shown', async () => {
    serve();
    await renderModels();
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    expect(screen.queryByRole('columnheader', { name: /Speed/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Speed (tokens/s)' }));
    expect(screen.getByRole('columnheader', { name: /Speed/ })).toBeTruthy();
    expect(within(rowOf('Alpha Max')).getByText('40')).toBeTruthy();
    cleanup();
    await renderModels();
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    expect(screen.getByRole('columnheader', { name: /Speed/ })).toBeTruthy();
  });

  it('expands a row to one line per effort without opening the drawer', async () => {
    serve();
    await renderModels();
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(screen.getByRole('button', { name: 'Show efforts of Alpha Max' }));
    const efforts = await screen.findByRole('table', { name: 'Efforts of Alpha Max' });
    const high = within(efforts).getByRole('row', { name: /high/ });
    expect(within(high).getByText('$2.50')).toBeTruthy();
    expect(within(high).getByText('75%')).toBeTruthy();
    const low = within(efforts).getByRole('row', { name: /low/ });
    expect(within(low).getByText('$0.40')).toBeTruthy();
    expect(within(low).getByText('25%')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for the account picked in Available on and shows its cost', async () => {
    const asked: (string | null)[] = [];
    const dearer = modelRowDto({
      ...STRONG,
      costPerTaskUsd: 2.75,
      efforts: [modelEffortDto({ effort: 'high', intelligence: 60, costPerTaskUsd: 2.75 })],
    });
    serve({ asked, forAccount: () => [dearer] });
    await renderModels();
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    expect(asked).toEqual([null]);
    fireEvent.click(screen.getByRole('button', { name: 'Filter Available on' }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Work key', hidden: true }));
    await waitFor(() => {
      expect(asked.at(-1)).toBe(KEYED.id);
    });
    expect(await within(rowOf('Alpha Max')).findByText('$2.75')).toBeTruthy();
  });

  describe('the Chart view', () => {
    const openChart = async () => {
      await renderModels();
      await screen.findByRole('button', { name: 'Open Alpha Max' });
      fireEvent.click(screen.getByRole('radio', { name: 'Chart' }));
    };

    it('prices the models and the picks on the default account when no account was chosen', async () => {
      const asked: (string | null)[] = [];
      const askedPicks: string[] = [];
      serve({ asked, askedPicks, forAccount: () => [STRONG] });
      await openChart();
      expect(await screen.findByText('Who each role gets')).toBeTruthy();
      await waitFor(() => {
        expect(asked.at(-1)).toBe(SUBSCRIPTION.id);
        expect(askedPicks).toEqual([SUBSCRIPTION.id]);
      });
    });

    it('waits for the accounts, then takes the default one', async () => {
      const asked: (string | null)[] = [];
      serve({ asked, forAccount: () => [STRONG] });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.use(
        http.get(daemonUrl('/accounts'), async () => {
          await gate;
          return HttpResponse.json([SUBSCRIPTION, KEYED]);
        }),
      );
      await openChart();
      expect(await screen.findByText('Reading accounts…')).toBeTruthy();
      expect(screen.queryByText('Add an account to see what each role gets.')).toBeNull();
      release();
      await waitFor(() => {
        expect(asked.at(-1)).toBe(SUBSCRIPTION.id);
      });
    });

    it('lists what each role gets, and says where a pick is not on the chart', async () => {
      serve({ forAccount: () => [STRONG] });
      await openChart();
      const panel = await screen.findByRole('region', { name: 'Who each role gets' });
      const plan = within(panel).getByText('Plan').closest('button');
      expect(plan).not.toBeNull();
      expect(within(plan as HTMLElement).getByText('Alpha Max')).toBeTruthy();
      expect(within(plan as HTMLElement).getByText(/high/)).toBeTruthy();
      expect(within(plan as HTMLElement).getByText(/\$2\.50/)).toBeTruthy();
      const review = within(panel).getByText('Review').closest('button');
      expect(within(review as HTMLElement).getByText('Not on the chart')).toBeTruthy();
      // A role with nothing chosen says why, not that it is off the chart.
      const qa = within(panel).getByText('QA').closest('button');
      expect(within(qa as HTMLElement).getByText(/refused here/)).toBeTruthy();
      expect(within(qa as HTMLElement).queryByText('Not on the chart')).toBeNull();
      expect(within(plan as HTMLElement).queryByText('Not on the chart')).toBeNull();
    });

    it('asks for the picks of the account chosen in the chart, which the table then shows too', async () => {
      const askedPicks: string[] = [];
      serve({ askedPicks, forAccount: () => [STRONG] });
      await openChart();
      await screen.findByText('Who each role gets');
      fireEvent.click(screen.getByRole('combobox', { name: 'Chart account' }));
      fireEvent.click(await screen.findByRole('option', { name: 'Work key', hidden: true }));
      await waitFor(() => {
        expect(askedPicks.at(-1)).toBe(KEYED.id);
      });
      fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Filter Available on' }));
      expect(await screen.findByDisplayValue('Work key')).toBeTruthy();
    });

    it('marks the selected role pressed, and clears it on a second click', async () => {
      serve({ forAccount: () => [STRONG] });
      await openChart();
      const panel = await screen.findByRole('region', { name: 'Who each role gets' });
      const implement = within(panel).getByText('Build').closest('button') as HTMLElement;
      expect(implement.getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(implement);
      expect(implement.getAttribute('aria-pressed')).toBe('true');
      expect(
        (within(panel).getByText('Plan').closest('button') as HTMLElement).getAttribute(
          'aria-pressed',
        ),
      ).toBe('false');
      fireEvent.click(implement);
      expect(implement.getAttribute('aria-pressed')).toBe('false');
    });

    it('says to add an account when there is none, and credits Artificial Analysis under the chart', async () => {
      serve({ accounts: [], forAccount: () => [STRONG] });
      await openChart();
      expect(await screen.findByText('Add an account to see what each role gets.')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Artificial Analysis' })).toBeTruthy();
    });
  });

  it('keeps the toolbar and offers every account when one account’s models cannot be read', async () => {
    serve();
    await renderModels();
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    server.use(
      http.get(daemonUrl('/models'), ({ request }) =>
        new URL(request.url).searchParams.has('account')
          ? HttpResponse.json({ error: 'boom' }, { status: 500 })
          : HttpResponse.json([FAST, STRONG, UNKNOWN, BLANK]),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filter Available on' }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Work key', hidden: true }));
    expect(await screen.findByText('The models of this account could not be read.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh Models' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show every account' }));
    expect(await screen.findByRole('button', { name: 'Open Alpha Max' })).toBeTruthy();
  });

  it('leaves the Chart for the Table when Show every account is chosen after a failed read', async () => {
    serve();
    server.use(
      http.get(daemonUrl('/models'), ({ request }) =>
        new URL(request.url).searchParams.has('account')
          ? HttpResponse.json({ error: 'boom' }, { status: 500 })
          : HttpResponse.json([FAST, STRONG, UNKNOWN, BLANK]),
      ),
    );
    await renderModels();
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(screen.getByRole('radio', { name: 'Chart' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show every account' }));
    expect(await screen.findByRole('button', { name: 'Open Alpha Max' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Table' }).hasAttribute('checked')).toBe(true);
  });

  it('filters by tier from the Tier column, one tier or several', async () => {
    serve();
    await renderModels();
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(screen.getByRole('button', { name: 'Filter Tier' }));
    const tiers = await screen.findByRole('group', { name: 'Tier' });
    fireEvent.click(within(tiers).getByRole('checkbox', { name: 'Fast' }));
    expect(shownNames()).toEqual(['Alpha Fast']);
    fireEvent.click(within(tiers).getByRole('checkbox', { name: 'Strongest' }));
    expect(shownNames()).toEqual(['Alpha Max', 'Alpha Fast']);
    fireEvent.click(within(tiers).getByRole('checkbox', { name: 'Fast' }));
    fireEvent.click(within(tiers).getByRole('checkbox', { name: 'Strongest' }));
    expect(shownNames()).toHaveLength(4);
  });

  it('filters by account from the Available on column', async () => {
    serve();
    await renderModels();
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(screen.getByRole('button', { name: 'Filter Available on' }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Work key', hidden: true }));
    expect(shownNames().sort()).toEqual(['Alpha Fast', 'Alpha Max']);
  });

  it('searches names and model IDs from the Model column, and says when nothing matches', async () => {
    serve();
    await renderModels();
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(screen.getByRole('button', { name: 'Filter Model' }));
    const search = await screen.findByRole('textbox', { name: 'Search models' });
    fireEvent.change(search, { target: { value: 'beta-pl' } });
    expect(shownNames()).toEqual(['Beta Plain']);
    fireEvent.change(search, { target: { value: 'nothing like it' } });
    expect(await screen.findByText('No model matches these filters.')).toBeTruthy();
  });

  it('sorts by a column, reverses on a second click, and keeps Unknown and blanks last', async () => {
    serve();
    await renderModels();
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    // The list opens by tier, strongest first; another column keeps that direction.
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Intelligence' }));
    expect(shownNames()).toEqual(['Alpha Max', 'Alpha Fast', 'Beta Plain', 'house-model']);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Intelligence, descending' }));
    expect(shownNames()).toEqual(['Alpha Fast', 'Alpha Max', 'Beta Plain', 'house-model']);
    expect(screen.getByRole('button', { name: 'Sort by Intelligence, ascending' })).toBeTruthy();
  });

  it('opens the drawer from a click anywhere on a row', async () => {
    serve();
    await renderModels();
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(within(rowOf('Alpha Max')).getByText('Strongest'));
    expect(await screen.findByRole('dialog', { name: 'Alpha Max' })).toBeTruthy();
  });

  it('says where the data came from and how old it is, and credits Artificial Analysis with a link', async () => {
    serve({ status: catalogueStatusDto({ fetchedAt: '2026-11-07T09:00:00.000Z', models: 40 }) });
    await renderModels();
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
    await renderModels();
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('says so when the catalogue status cannot be read, rather than waiting on it', async () => {
    serve();
    server.use(
      http.get(daemonUrl('/models/status'), () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    await renderModels();
    expect(await screen.findByText(/catalogue status could not be read/i)).toBeTruthy();
  });

  it('says there is no catalogue yet', async () => {
    serve({ status: catalogueStatusDto({ source: 'none', fetchedAt: null, models: 0 }), rows: [] });
    await renderModels();
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
    await renderModels();
    expect(await screen.findByText(/fetched 3 hours ago/)).toBeTruthy();
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
    await renderModels();
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
      firstSeenAt: null,
    });
    serve({ rows: [dateless] });
    await renderModels();
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
    await renderModels();
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
    expect(within(low).getByText('75%')).toBeTruthy();
    const high = within(drawer).getByRole('row', { name: /high/ });
    expect(within(high).getAllByText('—').length).toBeGreaterThan(0);
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
    await renderModels();
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
    await renderModels();
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
      availableOn: [KEYED.id],
    });
    serve({
      rows: [unconfirmed],
      offers: [accountModelDto({ accountId: SUBSCRIPTION.id, model: 'other' })],
    });
    await renderModels();
    fireEvent.click(await screen.findByRole('button', { name: 'Open gamma-new' }));
    const drawer = await screen.findByRole('dialog', { name: 'gamma-new' });
    expect(await within(drawer).findByText(/Work key has not listed its models yet/)).toBeTruthy();
  });
});

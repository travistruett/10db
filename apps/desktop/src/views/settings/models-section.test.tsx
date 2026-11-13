import {
  AccountId,
  mintId,
  type AccountDto,
  type AccountModelDto,
  type CatalogueStatusDto,
  type ModelProfileDto,
  type ModelRowDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountDto, DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
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
  it('opens on who each role gets, above the chart and the model list', async () => {
    serve();
    renderWithDaemon(<ModelsSection />);
    const roles = await screen.findByRole('region', { name: 'Who each role gets' });
    const all = await screen.findByRole('heading', { name: 'All models' });
    expect(roles.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Intelligence and cost' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Table' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Columns' })).toBeNull();
    const plan = within(roles).getByRole('row', { name: /Plan/ });
    expect(within(plan).getByText('Alpha Max · high')).toBeTruthy();
    expect(within(plan).getByText('$2.50')).toBeTruthy();
    // A pick the chart does not draw says so; a role with nothing chosen says why instead.
    expect(
      within(within(roles).getByRole('row', { name: /Review/ })).getByText('Not on the chart'),
    ).toBeTruthy();
    const qa = within(roles).getByRole('row', { name: /QA/ });
    expect(within(qa).getByText(/refused here/)).toBeTruthy();
    expect(within(qa).queryByText('Not on the chart')).toBeNull();
  });

  it('drives the rows and the picks from the one Account select, the default account first', async () => {
    const asked: (string | null)[] = [];
    const askedPicks: string[] = [];
    serve({ asked, askedPicks });
    renderWithDaemon(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    expect(asked).toEqual([SUBSCRIPTION.id]);
    expect(askedPicks).toEqual([SUBSCRIPTION.id]);
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveProperty(
      'value',
      'Claude plan',
    );
    await chooseAccount('Work key');
    await waitFor(() => {
      expect(asked.at(-1)).toBe(KEYED.id);
      expect(askedPicks.at(-1)).toBe(KEYED.id);
    });
    // The list narrows to what the account runs.
    await waitFor(() => {
      expect(shownNames().sort()).toEqual(['Alpha Fast', 'Alpha Max']);
    });
  });

  it('lists a row per model: tier, scores, cost, the roles that use it and steps run', async () => {
    serve();
    renderWithDaemon(<ModelsSection />);
    const row = within(
      await screen.findByRole('button', { name: 'Open Alpha Max' }).then(() => rowOf('Alpha Max')),
    );
    expect(row.getByText('Capable')).toBeTruthy();
    expect(row.getByText('Plan, Build')).toBeTruthy();
    for (const cell of ['60', '$2.50', '12']) {
      expect(row.getByText(cell)).toBeTruthy();
    }
    // Input, Output and Speed live in the drawer only.
    for (const title of [/Input/, /Output/, /Speed/, /Available on/])
      expect(screen.queryByRole('columnheader', { name: title })).toBeNull();
  });

  it('shows a dash where there is no data, never a zero', async () => {
    serve({ rows: [BLANK], forAccount: () => [BLANK] });
    renderWithDaemon(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Beta Plain' });
    const cells = within(rowOf('Beta Plain')).getAllByRole('cell');
    // Intelligence and Cost per task.
    expect(cells.slice(2, 4).map((c) => c.textContent)).toEqual(['—', '—']);
  });

  it('shows a status as dimmed text after the name, and New for a model first seen in the last seven days', async () => {
    serve();
    renderWithDaemon(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    expect(within(rowOf('Alpha Max')).getByText('New')).toBeTruthy();
    expect(within(rowOf('Alpha Fast')).queryByText('New')).toBeNull();
    const unknown = within(rowOf('house-model')).getByText('Unknown');
    expect(unknown.closest('.mantine-Badge-root')).toBeNull();
  });

  it('opens the drawer from a click anywhere on a row, with the effort table', async () => {
    serve();
    renderWithDaemon(<ModelsSection />);
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
    expect(within(drawer).getByText(/\$5\.00 in · \$25\.00 out · speed 40 tokens\/s/)).toBeTruthy();
    expect(within(drawer).getByRole('heading', { name: 'Offered by' })).toBeTruthy();
  });

  it('opens the drawer with Enter on a name', async () => {
    serve();
    renderWithDaemon(<ModelsSection />);
    const name = await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(name);
    expect(await screen.findByRole('dialog', { name: 'Alpha Max' })).toBeTruthy();
  });

  it('marks the selected role pressed, dims the others, and clears it on a second click', async () => {
    serve();
    renderWithDaemon(<ModelsSection />);
    const panel = await screen.findByRole('region', { name: 'Who each role gets' });
    const button = (label: string) => within(panel).getByRole('button', { name: label });
    expect(button('Build').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button('Build'));
    expect(button('Build').getAttribute('aria-pressed')).toBe('true');
    expect(button('Plan').getAttribute('aria-pressed')).toBe('false');
    expect(button('Plan').closest('tr')?.style.opacity).toBe('0.5');
    expect(button('Build').closest('tr')?.style.opacity).toBe('1');
    fireEvent.click(button('Build'));
    expect(button('Build').getAttribute('aria-pressed')).toBe('false');
    expect(button('Plan').closest('tr')?.style.opacity).toBe('1');
  });

  it('filters by tier from the Tier column, one tier or several', async () => {
    serve();
    renderWithDaemon(<ModelsSection />);
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
    renderWithDaemon(<ModelsSection />);
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
    renderWithDaemon(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    expect(shownNames()).toEqual(['Alpha Max', 'Alpha Fast', 'Beta Plain', 'house-model']);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Intelligence, descending' }));
    expect(shownNames()).toEqual(['Alpha Fast', 'Alpha Max', 'Beta Plain', 'house-model']);
    expect(screen.queryByRole('button', { name: 'Sort by Tier' })).toBeNull();
  });

  it('says to add an account when there is none, and lists no rows', async () => {
    serve({ accounts: [] });
    renderWithDaemon(<ModelsSection />);
    expect(await screen.findByText('Add an account to see what each role gets')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    expect(screen.getByRole('link', { name: 'Artificial Analysis' })).toBeTruthy();
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
    renderWithDaemon(<ModelsSection />);
    expect((await screen.findByRole('alert')).textContent).toContain('The list is down');
    expect(screen.queryByRole('button', { name: 'Show every account' })).toBeNull();
    healthy = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('button', { name: 'Open Alpha Max' })).toBeTruthy();
  });

  it('says where the data came from and how old it is, and credits Artificial Analysis with a link', async () => {
    serve({ status: catalogueStatusDto({ fetchedAt: '2026-11-07T09:00:00.000Z', models: 40 }) });
    renderWithDaemon(<ModelsSection />);
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
    renderWithDaemon(<ModelsSection />);
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('says so when the catalogue status cannot be read, rather than waiting on it', async () => {
    serve();
    server.use(
      http.get(daemonUrl('/models/status'), () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    renderWithDaemon(<ModelsSection />);
    expect(await screen.findByText(/catalogue status could not be read/i)).toBeTruthy();
  });

  it('says there is no catalogue yet', async () => {
    serve({ status: catalogueStatusDto({ source: 'none', fetchedAt: null, models: 0 }), rows: [] });
    renderWithDaemon(<ModelsSection />);
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
    renderWithDaemon(<ModelsSection />);
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
    renderWithDaemon(<ModelsSection />);
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
    renderWithDaemon(<ModelsSection />);
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
    renderWithDaemon(<ModelsSection />);
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
    renderWithDaemon(<ModelsSection />);
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
    renderWithDaemon(<ModelsSection />);
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
    renderWithDaemon(<ModelsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open gamma-new' }));
    const drawer = await screen.findByRole('dialog', { name: 'gamma-new' });
    expect(
      await within(drawer).findByText(/Claude plan, Work key have not listed its models yet/),
    ).toBeTruthy();
  });
});

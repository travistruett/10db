import type {
  AccountDto,
  AccountModelDto,
  CatalogueStatusDto,
  ModelProfileDto,
  ModelRowDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountDto, DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import {
  accountModelDto,
  catalogueStatusDto,
  modelProfileDto,
  modelRowDto,
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

function serve(
  opts: {
    rows?: ModelRowDto[];
    status?: CatalogueStatusDto;
    offers?: AccountModelDto[];
    profiles?: ModelProfileDto[];
  } = {},
) {
  server.use(
    http.get(daemonUrl('/models'), () =>
      HttpResponse.json(opts.rows ?? [FAST, STRONG, UNKNOWN, BLANK]),
    ),
    http.get(daemonUrl('/models/status'), () =>
      HttpResponse.json(opts.status ?? catalogueStatusDto()),
    ),
    http.get(daemonUrl('/models/offers'), () => HttpResponse.json(opts.offers ?? [])),
    http.get(daemonUrl('/model-profiles'), () => HttpResponse.json(opts.profiles ?? [])),
    http.get(daemonUrl('/accounts'), () => HttpResponse.json([SUBSCRIPTION, KEYED])),
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

describe('the Models page', () => {
  it('lists a row per model with its tier, accounts, scores, prices and speed', async () => {
    serve();
    renderWithDaemon(<ModelsSection />);
    const row = within(
      await screen.findByRole('button', { name: 'Open Alpha Max' }).then(() => rowOf('Alpha Max')),
    );
    expect(row.getByText('alpha-max')).toBeTruthy();
    expect(row.getByText('Strongest')).toBeTruthy();
    expect(row.getByText('Claude plan, Work key')).toBeTruthy();
    for (const cell of ['60', '40', '$5.00', '$25.00', '12']) {
      expect(row.getByText(cell)).toBeTruthy();
    }
  });

  it('shows a dash where there is no data, never a zero', async () => {
    serve({ rows: [BLANK] });
    renderWithDaemon(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Beta Plain' });
    const cells = within(rowOf('Beta Plain')).getAllByRole('cell');
    // Intelligence, Speed, Input and Output.
    expect(cells.slice(3, 7).map((c) => c.textContent)).toEqual(['—', '—', '—', '—']);
  });

  it('marks an Unknown model and a model first seen in the last seven days', async () => {
    serve();
    renderWithDaemon(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    expect(within(rowOf('Alpha Max')).getByText('New')).toBeTruthy();
    expect(within(rowOf('Alpha Fast')).queryByText('New')).toBeNull();
    expect(within(rowOf('house-model')).getByText('Unknown')).toBeTruthy();
  });

  it('filters by tier from the Tier column, one tier or several', async () => {
    serve();
    renderWithDaemon(<ModelsSection />);
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
    renderWithDaemon(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(screen.getByRole('button', { name: 'Filter Available on' }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Work key', hidden: true }));
    expect(shownNames().sort()).toEqual(['Alpha Fast', 'Alpha Max']);
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

  it('sorts by a column, reverses on a second click, and keeps Unknown and blanks last', async () => {
    serve();
    renderWithDaemon(<ModelsSection />);
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
    renderWithDaemon(<ModelsSection />);
    await screen.findByRole('button', { name: 'Open Alpha Max' });
    fireEvent.click(within(rowOf('Alpha Max')).getByText('Strongest'));
    expect(await screen.findByRole('dialog', { name: 'Alpha Max' })).toBeTruthy();
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
      availableOn: [KEYED.id],
    });
    serve({
      rows: [unconfirmed],
      offers: [accountModelDto({ accountId: SUBSCRIPTION.id, model: 'other' })],
    });
    renderWithDaemon(<ModelsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open gamma-new' }));
    const drawer = await screen.findByRole('dialog', { name: 'gamma-new' });
    expect(await within(drawer).findByText(/Work key has not listed its models yet/)).toBeTruthy();
  });
});

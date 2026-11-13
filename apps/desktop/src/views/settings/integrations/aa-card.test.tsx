import { BenchmarkKeyInput, type BenchmarkStatusDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { benchmarkStatusDto } from '../../../test/benchmark-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';
import { slackConnection } from '../../../test/people-fixtures';

const KEY = 'aa-test-key-not-a-secret';
const SYNCED = new Date(Date.now() - 2 * 60 * 60_000).toISOString();

/** The daemon as the card sees it: a status that the key routes change, and the sync that follows a key. */
function serve(
  start: Partial<Record<keyof BenchmarkStatusDto, unknown>> = {},
  options: {
    /** What the status becomes once the sync a new key starts has ended. */
    readonly afterSync?: Record<string, unknown>;
    readonly putRefusal?: { readonly status: number; readonly message: string };
    readonly path?: string;
  } = {},
) {
  let status = benchmarkStatusDto(start);
  const keys: string[] = [];
  const removals: string[] = [];
  const syncs: string[] = [];
  server.use(
    http.get(daemonUrl('/benchmarks/status'), () => HttpResponse.json(status)),
    http.put(daemonUrl('/benchmarks/key'), async ({ request }) => {
      if (options.putRefusal)
        return HttpResponse.json(
          { error: 'conflict', message: options.putRefusal.message },
          { status: options.putRefusal.status },
        );
      keys.push(BenchmarkKeyInput.parse(await request.json()).key);
      status = benchmarkStatusDto({ ...status, keyConfigured: true, syncing: true });
      return HttpResponse.json(status);
    }),
    http.delete(daemonUrl('/benchmarks/key'), () => {
      removals.push('key');
      status = benchmarkStatusDto({ keyConfigured: false });
      return HttpResponse.json(status);
    }),
    http.post(daemonUrl('/benchmarks/sync'), () => {
      syncs.push('sync');
      status = benchmarkStatusDto({
        ...status,
        outcome: 'ok',
        lastSyncAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
      });
      return HttpResponse.json(status);
    }),
    http.get(daemonUrl('/slack'), () => HttpResponse.json(slackConnection({ state: 'none' }))),
    http.get(daemonUrl('/people'), () => HttpResponse.json([])),
    ...baseHandlers(),
  );
  const finishSync = () => {
    status = benchmarkStatusDto({ ...status, syncing: false, ...options.afterSync });
  };
  return {
    keys,
    removals,
    syncs,
    finishSync,
    ...renderApp(options.path ?? '/settings/integrations'),
  };
}

const card = async () => within(await screen.findByRole('group', { name: 'Artificial Analysis' }));

describe('Settings › Integrations: Artificial Analysis', () => {
  it('lays out the four parts: name and state, what it is for, the actions, and what stops without it', async () => {
    serve();
    const aa = await card();
    expect(await aa.findByText('No key')).toBeTruthy();
    expect(
      aa.getByText(
        "Scores each model's intelligence and speed, so 10db can pick a model for each role.",
      ),
    ).toBeTruthy();
    expect(
      aa.getByText(
        "Without it: Models are compared without scores: each role takes its tier's model at its default effort.",
      ),
    ).toBeTruthy();
    expect(aa.getByRole('link', { name: 'Artificial Analysis' })).toBeTruthy();
  });

  it('with no key, Set Key is the way in and the key field is the only action', async () => {
    serve();
    const aa = await card();
    expect(await aa.findByLabelText('Artificial Analysis key')).toBeTruthy();
    expect(aa.getByRole('button', { name: 'Set Key' })).toHaveProperty('disabled', true);
    expect(aa.queryByRole('button', { name: 'Remove Key' })).toBeNull();
    expect(aa.queryByRole('button', { name: 'Sync Now' })).toBeNull();
  });

  it('Set Key sends the key, shows the check while the sync runs, and clears the field once it answers', async () => {
    const { keys, finishSync } = serve(
      {},
      {
        afterSync: {
          outcome: 'ok',
          lastSyncAt: SYNCED,
          lastSuccessAt: SYNCED,
          models: 12,
        },
      },
    );
    const aa = await card();
    const field = await aa.findByLabelText('Artificial Analysis key');
    fireEvent.change(field, { target: { value: ` ${KEY} ` } });
    fireEvent.click(aa.getByRole('button', { name: 'Set Key' }));
    expect(await aa.findByText('Checking the key…')).toBeTruthy();
    expect(keys).toEqual([KEY]);
    finishSync();
    expect(await aa.findByText('Key set · synced 2h ago · 12 models')).toBeTruthy();
    await waitFor(() => {
      expect(aa.getByLabelText('Artificial Analysis key')).toHaveProperty('value', '');
    });
  });

  it('a key AA refuses is named beside the field, which keeps the paste to correct', async () => {
    const { finishSync } = serve(
      {},
      { afterSync: { outcome: 'unauthorized', message: 'Artificial Analysis refused the key' } },
    );
    const aa = await card();
    fireEvent.change(await aa.findByLabelText('Artificial Analysis key'), {
      target: { value: KEY },
    });
    fireEvent.click(aa.getByRole('button', { name: 'Set Key' }));
    await aa.findByText('Checking the key…');
    finishSync();
    expect(await aa.findByText('AA refused this key')).toBeTruthy();
    expect(aa.getByLabelText('Artificial Analysis key')).toHaveProperty('value', KEY);
    expect(aa.getByRole('button', { name: 'Replace Key' })).toBeTruthy();
  });

  it.each([
    [
      'synced',
      {
        keyConfigured: true,
        outcome: 'ok',
        lastSyncAt: SYNCED,
        lastSuccessAt: SYNCED,
        models: 660,
      },
      'Key set · synced 2h ago · 660 models',
      null,
    ],
    [
      'rate limited after a good sync',
      {
        keyConfigured: true,
        outcome: 'rate_limited',
        message: 'The daily Artificial Analysis limit is used up',
        lastSyncAt: SYNCED,
        lastSuccessAt: SYNCED,
        models: 660,
      },
      'Key set · synced 2h ago · 660 models',
      'Rate limited, retrying. Routing uses the last good scores.',
    ],
    [
      'failed with nothing synced yet',
      {
        keyConfigured: true,
        outcome: 'failed',
        message: 'Artificial Analysis answered 500',
        lastSyncAt: SYNCED,
      },
      'Key set',
      'Sync failed: Artificial Analysis answered 500.',
    ],
    ['key set and not synced yet', { keyConfigured: true }, 'Key set', null],
  ])('with a key set and the sync %s', async (_name, status, header, note) => {
    serve(status);
    const aa = await card();
    expect(await aa.findByText(header)).toBeTruthy();
    if (note !== null) expect(aa.getByText(note)).toBeTruthy();
    expect(aa.getByRole('button', { name: 'Replace Key' })).toBeTruthy();
    expect(aa.getByRole('button', { name: 'Remove Key' })).toBeTruthy();
    expect(aa.getByRole('button', { name: 'Sync Now' })).toBeTruthy();
  });

  it('a stale outcome from a removed key reads as no key', async () => {
    serve({ keyConfigured: false, outcome: 'unauthorized' });
    expect(await (await card()).findByText('No key')).toBeTruthy();
  });

  it('Sync Now asks for a sync and shows its result', async () => {
    const { syncs } = serve({ keyConfigured: true });
    const aa = await card();
    fireEvent.click(await aa.findByRole('button', { name: 'Sync Now' }));
    await waitFor(() => {
      expect(syncs).toEqual(['sync']);
    });
    expect(await aa.findByText(/^Key set · synced just now/)).toBeTruthy();
  });

  it('Remove Key asks first, then removes the key', async () => {
    const { removals } = serve({ keyConfigured: true });
    const aa = await card();
    fireEvent.click(await aa.findByRole('button', { name: 'Remove Key' }));
    const ask = await screen.findByRole('dialog', { name: 'Remove the Artificial Analysis key?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(removals).toEqual([]);
    fireEvent.click(aa.getByRole('button', { name: 'Remove Key' }));
    fireEvent.click(
      within(
        await screen.findByRole('dialog', { name: 'Remove the Artificial Analysis key?' }),
      ).getByRole('button', { name: 'Remove Key' }),
    );
    await waitFor(() => {
      expect(removals).toEqual(['key']);
    });
    expect(await aa.findByText('No key')).toBeTruthy();
  });

  it('a Keychain that refuses the write says why beside Set Key, and keeps the paste', async () => {
    serve(
      {},
      {
        putRefusal: {
          status: 409,
          message: 'Writing the Keychain item failed (security exit status 36)',
        },
      },
    );
    const aa = await card();
    fireEvent.change(await aa.findByLabelText('Artificial Analysis key'), {
      target: { value: KEY },
    });
    fireEvent.click(aa.getByRole('button', { name: 'Set Key' }));
    expect(await aa.findByText(/Writing the Keychain item failed/)).toBeTruthy();
    expect(aa.getByLabelText('Artificial Analysis key')).toHaveProperty('value', KEY);
  });

  it('started with TENDB_BENCHMARKS=off, says so and offers no action', async () => {
    serve({ off: true });
    const aa = await card();
    expect(await aa.findByText('Off: 10db was started with TENDB_BENCHMARKS=off')).toBeTruthy();
    expect(aa.queryByRole('button')).toBeNull();
    expect(aa.queryByLabelText('Artificial Analysis key')).toBeNull();
  });

  it('keeps no trace of the key in query state once Set Key settles', async () => {
    const { queryClient } = serve();
    const aa = await card();
    fireEvent.change(await aa.findByLabelText('Artificial Analysis key'), {
      target: { value: KEY },
    });
    fireEvent.click(aa.getByRole('button', { name: 'Set Key' }));
    await aa.findByText('Checking the key…');
    const held = [
      ...queryClient
        .getMutationCache()
        .getAll()
        .map((m) => JSON.stringify(m.state.variables ?? null)),
      ...queryClient
        .getQueryCache()
        .getAll()
        .map((q) => JSON.stringify(q.state.data ?? null)),
    ];
    expect(held.join('')).not.toContain(KEY);
  });

  it('a link with ?focus=artificial-analysis moves keyboard focus into the card', async () => {
    serve({}, { path: '/settings/integrations?focus=artificial-analysis' });
    const aa = await card();
    await waitFor(() => {
      expect(document.activeElement).toBe(aa.getByLabelText('Artificial Analysis key'));
    });
  });

  it('an unknown ?focus= opens the section and focuses nothing', async () => {
    serve({}, { path: '/settings/integrations?focus=nothing-here' });
    const aa = await card();
    await aa.findByText('No key');
    expect(document.activeElement).toBe(document.body);
  });
});

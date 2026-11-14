import { KindInput, KindOrderInput, KindPatch, type KindDto } from '@10db/contracts';
import {
  fireEvent,
  screen,
  waitFor,
  within,
  type BoundFunctions,
  type queries,
} from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { openOptions, pickOption } from '../../test/combobox';
import { projectDto } from '../../test/fixtures';
import { kindDto } from '../../test/playbook-fixtures';
import { KindsSection } from './kinds-section';

const SECURITY = kindDto({
  key: 'security',
  label: 'Security',
  minimumRigor: 'careful',
  alwaysReviewed: true,
  toInbox: true,
  overrides: {
    review: { personaId: null, model: { kind: 'tier', tier: 'frontier' }, effort: 'high' },
  },
  position: 0,
});
const DOCS = kindDto({ key: 'docs', label: 'Docs', position: 1 });

interface Calls {
  readonly created: unknown[];
  readonly patched: { id: string; body: KindPatch }[];
  readonly deleted: string[];
  readonly moved: unknown[];
}

function serve(kinds: KindDto[] = [SECURITY, DOCS]): Calls {
  const calls: Calls = { created: [], patched: [], deleted: [], moved: [] };
  server.use(
    http.get(daemonUrl('/kinds'), () => HttpResponse.json(kinds)),
    http.post(daemonUrl('/kinds'), async ({ request }) => {
      const body = KindInput.parse(await request.json());
      calls.created.push(body);
      return HttpResponse.json(kindDto({ ...body, position: kinds.length }), { status: 201 });
    }),
    http.patch(daemonUrl('/kinds/:kindId'), async ({ request, params }) => {
      calls.patched.push({
        id: String(params['kindId']),
        body: KindPatch.parse(await request.json()),
      });
      return HttpResponse.json(SECURITY);
    }),
    http.delete(daemonUrl('/kinds/:kindId'), ({ params }) => {
      calls.deleted.push(String(params['kindId']));
      return new HttpResponse(null, { status: 204 });
    }),
    http.put(daemonUrl('/kinds/order'), async ({ request }) => {
      calls.moved.push(KindOrderInput.parse(await request.json()));
      return HttpResponse.json(kinds);
    }),
    ...baseHandlers(),
  );
  return calls;
}

/** The body of one role's override in the open drawer; the accordion keeps every panel mounted. */
function panelOf(drawer: BoundFunctions<typeof queries>, role: string): HTMLElement {
  const id = drawer
    .getByRole('button', { name: `${role} override`, hidden: true })
    .getAttribute('aria-controls');
  const panel = id === null ? null : document.getElementById(id);
  if (panel === null) throw new Error(`no panel for ${role}`);
  return panel;
}

async function openKind(label: string) {
  fireEvent.click(await screen.findByText(label));
  return within(await screen.findByRole('dialog', { name: label }));
}

describe('the kinds list', () => {
  it('lists each kind with its key, minimum rigor and switches, in order', async () => {
    serve();
    renderWithDaemon(<KindsSection />);
    const security = within(await screen.findByRole('row', { name: /Security/ }));
    expect(security.getByText('security')).toBeTruthy();
    expect(security.getByText('Careful')).toBeTruthy();
    expect(security.getByText('Always reviewed')).toBeTruthy();
    expect(security.getByText('Inbox')).toBeTruthy();
    expect(security.getByText('Review')).toBeTruthy();
    const names = screen.getAllByRole('row').map((r) => r.textContent);
    expect(names.findIndex((n) => n.includes('Security'))).toBeLessThan(
      names.findIndex((n) => n.includes('Docs')),
    );
  });

  it('moves a kind down one place, and the first and last have nowhere to go on their own side', async () => {
    const calls = serve();
    renderWithDaemon(<KindsSection />);
    await screen.findByRole('row', { name: /Security/ });
    expect(screen.getByRole('button', { name: 'Move Security up' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Move Docs down' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Move Security down' }));
    await waitFor(() => {
      expect(calls.moved).toEqual([{ kindId: SECURITY.id, position: 1 }]);
    });
    // The arrows do not open the drawer behind them.
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('a kind’s drawer', () => {
  it('shows the key read-only, and a save sends every field but the key', async () => {
    const calls = serve();
    renderWithDaemon(<KindsSection />);
    const drawer = await openKind('Security');
    const key = drawer.getByRole('textbox', { name: 'Key', hidden: true });
    expect(key).toHaveProperty('readOnly', true);
    expect(key).toHaveProperty('value', 'security');
    fireEvent.change(drawer.getByRole('textbox', { name: 'Label', hidden: true }), {
      target: { value: 'Security work' },
    });
    fireEvent.click(drawer.getByRole('button', { name: 'Save', hidden: true }));
    await waitFor(() => {
      expect(calls.patched).toHaveLength(1);
    });
    const [saved] = calls.patched;
    expect(saved?.id).toBe(SECURITY.id);
    expect(saved?.body).toMatchObject({
      label: 'Security work',
      minimumRigor: 'careful',
      alwaysReviewed: true,
      toInbox: true,
      overrides: SECURITY.overrides,
    });
    expect(saved?.body).not.toHaveProperty('key');
  });

  it('saves an override under the role it was set in, and no other', async () => {
    const calls = serve([DOCS]);
    renderWithDaemon(<KindsSection />);
    const drawer = await openKind('Docs');
    fireEvent.click(drawer.getByRole('button', { name: 'Review override', hidden: true }));
    const review = within(panelOf(drawer, 'Review'));
    fireEvent.click(review.getByRole('combobox', { name: 'Effort', hidden: true }));
    fireEvent.click(await screen.findByRole('option', { name: 'High', hidden: true }));
    fireEvent.click(drawer.getByRole('button', { name: 'Save', hidden: true }));
    await waitFor(() => {
      expect(calls.patched).toHaveLength(1);
    });
    expect(calls.patched[0]?.body).toMatchObject({
      overrides: { review: { personaId: null, model: null, effort: 'high' } },
    });
    expect(Object.keys(calls.patched[0]?.body.overrides ?? {})).toEqual(['review']);
  });

  it('saves what implies the kind and the craft skills it loads', async () => {
    const calls = serve([DOCS]);
    renderWithDaemon(<KindsSection />);
    const drawer = await openKind('Docs');
    await pickOption(
      drawer.getByRole('combobox', { name: 'Implied by', hidden: true }),
      'migrations',
    );
    await pickOption(drawer.getByRole('combobox', { name: 'Skills', hidden: true }), 'Test First');
    fireEvent.click(drawer.getByRole('button', { name: 'Save', hidden: true }));
    await waitFor(() => {
      expect(calls.patched).toHaveLength(1);
    });
    expect(calls.patched[0]?.body).toMatchObject({
      impliedBy: ['migrations'],
      skills: ['test-first'],
    });
  });

  it('offers the stock hazards and every project’s areas and hazards as what implies a kind', async () => {
    serve([DOCS]);
    server.use(
      http.get(daemonUrl('/projects'), () =>
        HttpResponse.json([
          projectDto({
            areas: [{ name: 'billing', globs: ['src/billing/**'] }],
            hazards: [{ name: 'secrets', globs: ['.env*'], commands: [] }],
          }),
        ]),
      ),
    );
    renderWithDaemon(<KindsSection />);
    const drawer = await openKind('Docs');
    const list = await openOptions(
      drawer.getByRole('combobox', { name: 'Implied by', hidden: true }),
    );
    for (const name of ['migrations', 'deps', 'billing', 'secrets'])
      await waitFor(() => {
        expect(within(list).getByRole('option', { name, hidden: true })).toBeTruthy();
      });
  });

  it('drops an override that was cleared, so no empty one is stored', async () => {
    const calls = serve([SECURITY]);
    renderWithDaemon(<KindsSection />);
    const drawer = await openKind('Security');
    fireEvent.click(drawer.getByRole('button', { name: 'Review override', hidden: true }));
    const review = within(panelOf(drawer, 'Review'));
    fireEvent.click(review.getByRole('button', { name: 'Clear Override', hidden: true }));
    fireEvent.click(drawer.getByRole('button', { name: 'Save', hidden: true }));
    await waitFor(() => {
      expect(calls.patched).toHaveLength(1);
    });
    expect(calls.patched[0]?.body).toMatchObject({ overrides: {} });
  });

  it('adds a kind with a typed key, and refuses a key that is not hyphenated words', async () => {
    const calls = serve([]);
    renderWithDaemon(<KindsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Kind' }));
    const drawer = within(await screen.findByRole('dialog', { name: 'Add Kind' }));
    const add = drawer.getByRole('button', { name: 'Add Kind', hidden: true });
    fireEvent.change(drawer.getByRole('textbox', { name: 'Label', hidden: true }), {
      target: { value: 'Payments' },
    });
    fireEvent.change(drawer.getByRole('textbox', { name: 'Key', hidden: true }), {
      target: { value: 'Not A Key' },
    });
    expect(add).toHaveProperty('disabled', true);
    fireEvent.change(drawer.getByRole('textbox', { name: 'Key', hidden: true }), {
      target: { value: 'payments' },
    });
    expect(add).toHaveProperty('disabled', false);
    fireEvent.click(add);
    await waitFor(() => {
      expect(calls.created).toHaveLength(1);
    });
    expect(calls.created[0]).toMatchObject({ key: 'payments', label: 'Payments' });
  });

  it('deletes only after a confirmation', async () => {
    const calls = serve();
    renderWithDaemon(<KindsSection />);
    const drawer = await openKind('Docs');
    fireEvent.click(drawer.getByRole('button', { name: 'Delete Kind', hidden: true }));
    const confirm = within(await screen.findByRole('dialog', { name: 'Delete Kind' }));
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(calls.deleted).toEqual([]);
    fireEvent.click(drawer.getByRole('button', { name: 'Delete Kind', hidden: true }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Delete Kind' })).getByRole('button', {
        name: 'Delete Kind',
      }),
    );
    await waitFor(() => {
      expect(calls.deleted).toEqual([DOCS.id]);
    });
  });
});

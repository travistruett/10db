import {
  mintId,
  type DecisionItem,
  type PrincipleItem,
  type ProposalDto,
  type ProvenanceDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { inboxItemDto, projectViewDto } from '../../test/fixtures';
import {
  decisionItem,
  knowledgePage,
  principleItem,
  proposalDto,
  provenanceDto,
} from '../../test/knowledge-fixtures';
import { chooseShelf } from '../../test/knowledge-table';

const project = projectViewDto({ areas: [{ name: 'api', globs: ['src/api/**'] }] });

interface Served {
  principles: PrincipleItem[];
  decisions: DecisionItem[];
  proposals: ProposalDto[];
  provenance: Record<string, ProvenanceDto>;
}

interface Posted {
  readonly path: string;
  readonly body: unknown;
}

type Reply = (body: unknown) => { status: number; json: JsonBodyType };

const DecisionBody = z.object({ question: z.string(), choice: z.string(), rationale: z.string() });
const PrincipleBody = z.object({ statement: z.string(), topicKey: z.string() });
const DryRunBody = z.object({ dryRun: z.literal(true) });

/** Serves one project's knowledge; every write is noted, and answered by `replies[route]` or a refusal-free default. */
function serve(data: Partial<Served> = {}, replies: Record<string, Reply> = {}) {
  const served: Served = {
    principles: [],
    decisions: [],
    proposals: [],
    provenance: {},
    ...data,
  };
  const posted: Posted[] = [];
  const dryRuns: Posted[] = [];
  const inboxReads = { count: 0 };
  const write =
    (route: string, fallback: Reply) =>
    async ({ request }: { request: Request }) => {
      const body: unknown = await request.json();
      const path = new URL(request.url).pathname;
      if (DryRunBody.safeParse(body).success) {
        // A dry run writes nothing: it is noted apart, and answered by `replies[`${route}-dry-run`]`.
        dryRuns.push({ path, body });
        const dry = (replies[`${route}-dry-run`] ?? (() => ({ status: 200, json: noRestore })))(
          body,
        );
        return HttpResponse.json(dry.json, { status: dry.status });
      }
      posted.push({ path, body });
      const out = (replies[route] ?? fallback)(body);
      return HttpResponse.json(out.json, { status: out.status });
    };
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/knowledge'), ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind');
      return HttpResponse.json(
        knowledgePage(
          kind === 'decision' ? served.decisions : served.principles,
          new URL(request.url).searchParams,
        ),
      );
    }),
    http.get(daemonUrl('/projects/:projectId/proposals'), () =>
      HttpResponse.json(served.proposals),
    ),
    http.get(daemonUrl('/decisions/:id/provenance'), ({ params }) =>
      HttpResponse.json(served.provenance[String(params['id'])] ?? provenanceDto()),
    ),
    http.get(daemonUrl('/principles/:id/provenance'), ({ params }) =>
      HttpResponse.json(served.provenance[String(params['id'])] ?? provenanceDto()),
    ),
    http.get(daemonUrl('/inbox'), () => {
      inboxReads.count += 1;
      return HttpResponse.json([inboxItemDto()]);
    }),
    http.post(
      daemonUrl('/projects/:projectId/decisions'),
      write('decision', (body) => {
        const created = decisionItem({ ...DecisionBody.parse(body), scope: 'area', area: 'api' });
        served.decisions = [created, ...served.decisions];
        return { status: 201, json: created };
      }),
    ),
    http.post(
      daemonUrl('/projects/:projectId/principles'),
      write('principle', (body) => {
        const created = principleItem(PrincipleBody.parse(body));
        served.principles = [created, ...served.principles];
        return { status: 201, json: created };
      }),
    ),
    http.post(
      daemonUrl('/decisions/:id/supersede'),
      write('decision-supersede', () => ({ status: 201, json: decisionItem() })),
    ),
    http.post(
      daemonUrl('/principles/:id/supersede'),
      write('principle-supersede', () => ({ status: 201, json: principleItem() })),
    ),
    http.post(
      daemonUrl('/decisions/:id/withdraw'),
      write('decision-withdraw', () => ({
        status: 200,
        json: decisionItem({ state: 'withdrawn' }),
      })),
    ),
    http.post(
      daemonUrl('/principles/:id/withdraw'),
      write('principle-withdraw', () => ({
        status: 200,
        json: principleItem({ state: 'withdrawn' }),
      })),
    ),
    http.post(
      daemonUrl('/principles/:id/retire'),
      write('principle-retire', () => ({ status: 200, json: principleItem({ state: 'retired' }) })),
    ),
    http.post(
      daemonUrl('/proposals/:id/accept'),
      write('accept', () => ({ status: 200, json: proposalDto({ status: 'accepted' }) })),
    ),
    http.post(
      daemonUrl('/proposals/:id/reject'),
      write('reject', () => ({ status: 200, json: proposalDto({ status: 'rejected' }) })),
    ),
    ...baseHandlers(),
  );
  return { served, posted, dryRuns, inboxReads };
}

/** What a withdrawal's dry run answers when no older version would become current again. */
/** A dry run of a new or accepted principle that would replace no current one. */
const replacesNothing: Reply = () => ({ status: 200, json: { ...noRestore, replaces: null } });

const noRestore = {
  dryRun: true,
  wouldWrite: decisionItem({ state: 'withdrawn' }),
  replaces: decisionItem(),
  restores: null,
};

/** A dry run's answer: the withdrawal would make `restores` current again. */
const restoring =
  (restores: DecisionItem | PrincipleItem): Reply =>
  () => ({
    status: 200,
    json: {
      dryRun: true,
      wouldWrite: { ...restores, state: 'withdrawn' },
      replaces: restores,
      restores,
    },
  });

/** Opens a Select inside `scope` by its label and picks an option. */
async function choose(scope: HTMLElement, label: string, option: string) {
  const input = within(scope).getByLabelText(label);
  fireEvent.click(input);
  const id = input.getAttribute('aria-controls');
  const list = await waitFor(() => {
    const el = id === null ? null : document.getElementById(id);
    expect(el).not.toBeNull();
    return el ?? document.body;
  });
  fireEvent.click(within(list).getByRole('option', { name: option, hidden: true }));
}

const refusal = (status: number, message: string): Reply => {
  return () => ({
    status,
    json: { error: status === 409 ? 'conflict' : 'invalid', message },
  });
};

async function openDecisions() {
  renderApp('/knowledge');
  fireEvent.click(await screen.findByRole('tab', { name: 'Decisions' }));
}

/** What the Withdraw dialog says when the dry run failed for a reason other than a refusal. */
const COULD_NOT_CHECK = /Couldn’t check whether an older version would become current again/;

/** Waits until the dry run has been answered (or has failed): only then can Withdraw be sent. */
async function dryRunAnswered(dialog: HTMLElement) {
  await waitFor(() => {
    const button = within(dialog).getByRole('button', { name: 'Remove' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
}

async function openRowMenu(name: string, item: string) {
  fireEvent.click(await screen.findByRole('button', { name }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

describe('recording', () => {
  it('records a decision at a chosen area, and shows it in the list at once', async () => {
    const { posted } = serve();
    await openDecisions();
    fireEvent.click(await screen.findByRole('button', { name: 'New Decision' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Decision' });
    fireEvent.change(within(dialog).getByLabelText('Question'), {
      target: { value: 'Which router?' },
    });
    fireEvent.change(within(dialog).getByLabelText('Choice'), { target: { value: 'Hono' } });
    fireEvent.change(within(dialog).getByLabelText('Rationale'), {
      target: { value: 'Typed client' },
    });
    await choose(dialog, 'Applies to', 'Only in api');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(posted).toEqual([
        {
          path: `/projects/${project.id}/decisions`,
          body: {
            scope: 'area',
            area: 'api',
            question: 'Which router?',
            choice: 'Hono',
            rationale: 'Typed client',
          },
        },
      ]);
    });
    expect(await screen.findByText('Which router?')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'New Decision' })).toBeNull();
  });

  it('asks for every field of a decision before it writes', async () => {
    const { posted } = serve();
    await openDecisions();
    fireEvent.click(await screen.findByRole('button', { name: 'New Decision' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Decision' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record' }));
    expect(
      await within(dialog).findByText('Fill in the question, the choice and the rationale.'),
    ).toBeTruthy();
    expect(posted).toEqual([]);
  });

  it('writes a principle for You, naming it by a key made from its statement', async () => {
    const { posted } = serve({}, { 'principle-dry-run': replacesNothing });
    renderApp('/knowledge');
    fireEvent.click(await screen.findByRole('button', { name: 'New Principle' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Principle' });
    expect(within(dialog).queryByLabelText('Topic key')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Statement'), {
      target: { value: 'Prefer small PRs' },
    });
    // Each kind says what it does to an agent.
    expect(within(dialog).getByText(/Every session is briefed with it\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Rule/ }));
    await choose(dialog, 'Applies to', 'All Projects');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(posted).toEqual([
        {
          path: `/projects/${project.id}/principles`,
          body: {
            scope: 'you',
            statement: 'Prefer small PRs',
            kind: 'policy',
            topicKey: 'prefer-small-prs',
          },
        },
      ]);
    });
    expect(await screen.findByText('Prefer small PRs')).toBeTruthy();
  });
});

describe('replacing', () => {
  it.each([
    {
      name: 'a new principle',
      route: 'principle-dry-run',
      open: 'New Principle',
      dialog: 'New Principle',
      save: 'Save',
    },
    {
      name: 'an accepted proposal',
      route: 'accept-dry-run',
      open: 'Accept',
      dialog: 'Accept Proposal',
      save: 'Accept',
    },
  ])(
    'names the current principle $name would replace, and writes only once Replace is chosen',
    async ({ route, open, dialog: dialogName, save }) => {
      const current = principleItem({ statement: 'Keep tests fast' });
      const { posted, dryRuns } = serve(
        { proposals: [proposalDto({ projectId: project.id })] },
        { [route]: () => ({ status: 200, json: { ...noRestore, replaces: current } }) },
      );
      renderApp('/knowledge');
      if (open === 'Accept') await chooseShelf(/^Pending/);
      fireEvent.click(await screen.findByRole('button', { name: open }));
      const dialog = await screen.findByRole('dialog', { name: dialogName });
      fireEvent.change(within(dialog).getByLabelText('Statement'), {
        target: { value: 'Keep tests under a second' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: save }));
      expect(await within(dialog).findByText(/“Keep tests fast” has the same topic/)).toBeTruthy();
      expect(dryRuns).toHaveLength(1);
      expect(posted).toEqual([]);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
      await waitFor(() => {
        expect(posted).toHaveLength(1);
      });
    },
  );
});

describe('editing', () => {
  it('opens a decision with its text and scope, and saves a successor', async () => {
    const decision = decisionItem({ scope: 'area', area: 'api', projectId: project.id });
    const { posted } = serve({ decisions: [decision] });
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit Decision' });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Question').value).toBe(
      'Which queue library?',
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('Applies to').value).toBe('Only in api');
    fireEvent.change(within(dialog).getByLabelText('Choice'), { target: { value: 'pg-boss' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(posted).toEqual([
        {
          path: `/decisions/${decision.id}/supersede`,
          body: {
            scope: 'area',
            area: 'api',
            projectId: project.id,
            question: 'Which queue library?',
            choice: 'pg-boss',
            rationale: 'Redis is already deployed',
          },
        },
      ]);
    });
  });

  it('edits a principle without changing its key, and sends the scope the builder chose', async () => {
    const principle = principleItem({ projectId: project.id });
    const { posted } = serve({ principles: [principle] });
    renderApp('/knowledge');
    await openRowMenu('Actions for "Never sleep in tests"', 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit Principle' });
    fireEvent.change(within(dialog).getByLabelText('Statement'), {
      target: { value: 'Tests never sleep' },
    });
    await choose(dialog, 'Applies to', 'All Projects');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(posted).toEqual([
        {
          path: `/principles/${principle.id}/supersede`,
          body: {
            scope: 'you',
            statement: 'Tests never sleep',
            kind: 'policy',
            topicKey: 'testing.no-sleeps',
          },
        },
      ]);
    });
  });

  it('shows the daemon’s message, naming the principle, when the key is already taken', async () => {
    const message =
      'Principle pri_other already holds the key prs.small at that scope; supersede or retire it first';
    serve(
      { principles: [principleItem({ projectId: project.id })] },
      { 'principle-supersede': refusal(409, message) },
    );
    renderApp('/knowledge');
    await openRowMenu('Actions for "Never sleep in tests"', 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit Principle' });
    fireEvent.change(within(dialog).getByLabelText('Statement'), {
      target: { value: 'Prefer small PRs' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(message)).toBeTruthy();
  });

  it('takes a row’s menu out of the page the moment an item is chosen, so the next menu is the only one', async () => {
    serve({ principles: [principleItem({ projectId: project.id })] });
    renderApp('/knowledge');
    await openRowMenu('Actions for "Never sleep in tests"', 'Edit');
    await screen.findByRole('dialog', { name: 'Edit Principle' });
    // `hidden` counts a menu that is only fading out: a closing menu must not linger beside the next one.
    expect(screen.queryAllByRole('menu', { hidden: true })).toHaveLength(0);
    expect(screen.queryAllByRole('menuitem', { hidden: true })).toHaveLength(0);
  });

  it('offers Edit only on a current record', async () => {
    serve({
      principles: [
        principleItem({ state: 'superseded', statement: 'Old rule', topicKey: 'old.rule' }),
      ],
    });
    renderApp('/knowledge');
    await chooseShelf('Past');
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for "Old rule"' }));
    expect(await screen.findByRole('menuitem', { name: 'Remove' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
  });
});

describe('retiring and withdrawing', () => {
  it('asks for a reason to withdraw a decision, and says where it goes', async () => {
    const decision = decisionItem({ projectId: project.id });
    const { posted } = serve({ decisions: [decision] });
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    expect(
      within(dialog).getByText(
        /leaves briefings and search\. It stays under Past with your reason\./,
      ),
    ).toBeTruthy();
    await dryRunAnswered(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByText('Say why.')).toBeTruthy();
    expect(posted).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Recorded by mistake' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(posted).toEqual([
        { path: `/decisions/${decision.id}/withdraw`, body: { reason: 'Recorded by mistake' } },
      ]);
    });
  });

  it('names the older decision a withdrawal makes current again, before the builder confirms', async () => {
    const older = decisionItem({ question: 'Which queue?', choice: 'Graphile' });
    const decision = decisionItem({
      projectId: project.id,
      question: 'Which queue?',
      choice: 'pg-boss',
      supersedesId: older.id,
    });
    const { posted, dryRuns } = serve(
      { decisions: [decision] },
      { 'decision-withdraw-dry-run': restoring(older) },
    );
    await openDecisions();
    await openRowMenu('Actions for "Which queue?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    expect(
      await within(dialog).findByText(
        /“Which queue\? → Graphile” becomes current again, and returns to briefings and search\./,
      ),
    ).toBeTruthy();
    expect(dryRuns).toHaveLength(1);
    expect(dryRuns[0]?.path).toBe(`/decisions/${decision.id}/withdraw`);
    expect(posted).toEqual([]);
  });

  it('names the older principle a withdrawal makes current again', async () => {
    const older = principleItem({ statement: 'Sleep sparingly in tests' });
    const principle = principleItem({ projectId: project.id, supersedesId: older.id });
    serve({ principles: [principle] }, { 'principle-withdraw-dry-run': restoring(older) });
    renderApp('/knowledge');
    await openRowMenu('Actions for "Never sleep in tests"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Principle' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'It was recorded by mistake' }));
    expect(
      await within(dialog).findByText(/“Sleep sparingly in tests” becomes current again/),
    ).toBeTruthy();
  });

  it('says nothing of an older version when a withdrawal restores none', async () => {
    const decision = decisionItem({ projectId: project.id });
    const { dryRuns } = serve({ decisions: [decision] });
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    await dryRunAnswered(dialog);
    expect(dryRuns).toHaveLength(1);
    expect(within(dialog).getByText(/leaves briefings and search\./)).toBeTruthy();
    expect(within(dialog).queryByText(/current again/)).toBeNull();
    expect(within(dialog).queryByText(/older version/)).toBeNull();
  });

  it('cannot send a withdrawal while the dry run is outstanding', async () => {
    const decision = decisionItem({ projectId: project.id });
    const { posted } = serve({ decisions: [decision] });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post(daemonUrl('/decisions/:id/withdraw'), async ({ request }) => {
        const body: unknown = await request.clone().json();
        if (!DryRunBody.safeParse(body).success) return undefined;
        await gate;
        return HttpResponse.json(noRestore);
      }),
    );
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Oops' } });
    const button = within(dialog).getByRole('button', { name: 'Remove' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    fireEvent.submit(within(dialog).getByLabelText('Reason').closest('form') ?? dialog);
    expect(posted).toEqual([]);
    release();
    await dryRunAnswered(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
  });

  it('says it is checking for an older version while the dry run is outstanding', async () => {
    const decision = decisionItem({ projectId: project.id });
    serve({ decisions: [decision] });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post(daemonUrl('/decisions/:id/withdraw'), async ({ request }) => {
        const body: unknown = await request.clone().json();
        if (!DryRunBody.safeParse(body).success) return undefined;
        await gate;
        return HttpResponse.json(noRestore);
      }),
    );
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    const checking = /Checking whether an older version would become current again/;
    expect(within(dialog).getByText(checking)).toBeTruthy();
    release();
    await dryRunAnswered(dialog);
    expect(within(dialog).queryByText(checking)).toBeNull();
  });

  it('still lets the builder withdraw when the preview is refused', async () => {
    const decision = decisionItem({ projectId: project.id });
    const message = 'Decision dec_x is already withdrawn (none is current)';
    const { posted } = serve(
      { decisions: [decision] },
      { 'decision-withdraw-dry-run': refusal(409, message) },
    );
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    await dryRunAnswered(dialog);
    // The real withdrawal meets the same check, so a refusal is not reported as a failed check.
    expect(within(dialog).queryByText(COULD_NOT_CHECK)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Oops' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
  });

  it('treats a 400 refusal of the preview the same way', async () => {
    const decision = decisionItem({ projectId: project.id });
    serve({ decisions: [decision] }, { 'decision-withdraw-dry-run': refusal(400, 'Say why.') });
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    await dryRunAnswered(dialog);
    expect(within(dialog).queryByText(COULD_NOT_CHECK)).toBeNull();
  });

  it('says it could not check for an older version when the preview fails, and still lets the builder withdraw', async () => {
    const decision = decisionItem({ projectId: project.id });
    const { posted } = serve(
      { decisions: [decision] },
      {
        'decision-withdraw-dry-run': () => ({ status: 500, json: { error: 'internal' } }),
      },
    );
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    expect(await within(dialog).findByText(COULD_NOT_CHECK)).toBeTruthy();
    await dryRunAnswered(dialog);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Oops' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
  });

  it('says it could not check when the preview’s answer does not parse', async () => {
    const decision = decisionItem({ projectId: project.id });
    serve(
      { decisions: [decision] },
      { 'decision-withdraw-dry-run': () => ({ status: 200, json: { nonsense: true } }) },
    );
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    expect(await within(dialog).findByText(COULD_NOT_CHECK)).toBeTruthy();
    await dryRunAnswered(dialog);
  });

  it('says it could not check when the connection drops during the preview', async () => {
    const decision = decisionItem({ projectId: project.id });
    serve({ decisions: [decision] });
    server.use(
      http.post(daemonUrl('/decisions/:id/withdraw'), async ({ request }) => {
        const body: unknown = await request.clone().json();
        if (!DryRunBody.safeParse(body).success) return undefined;
        return HttpResponse.error();
      }),
    );
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    expect(await within(dialog).findByText(COULD_NOT_CHECK)).toBeTruthy();
    await dryRunAnswered(dialog);
  });

  it('asks why a current principle is removed, and retires one that no longer applies', async () => {
    const principle = principleItem({ projectId: project.id });
    const { posted } = serve({ principles: [principle] });
    renderApp('/knowledge');
    await openRowMenu('Actions for "Never sleep in tests"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Principle' });
    // Nothing is sent until the builder says why.
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'It no longer applies' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByText('Say why.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Fake timers now' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(posted).toEqual([
        { path: `/principles/${principle.id}/retire`, body: { reason: 'Fake timers now' } },
      ]);
    });
  });

  it('withdraws a principle recorded by mistake', async () => {
    const principle = principleItem({ projectId: project.id });
    const { posted } = serve({ principles: [principle] });
    renderApp('/knowledge');
    await openRowMenu('Actions for "Never sleep in tests"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Principle' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'It was recorded by mistake' }));
    await dryRunAnswered(dialog);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Wrong repo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(posted).toEqual([
        { path: `/principles/${principle.id}/withdraw`, body: { reason: 'Wrong repo' } },
      ]);
    });
  });

  it('shows the daemon’s refusal when a withdrawal is refused', async () => {
    const message = 'Decision dec_x is already withdrawn (none is current)';
    serve(
      { decisions: [decisionItem({ projectId: project.id })] },
      { 'decision-withdraw': refusal(409, message) },
    );
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    await dryRunAnswered(dialog);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Oops' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByText(message)).toBeTruthy();
  });

  it('refuses to withdraw a version that has a newer one, and offers the newest', async () => {
    const older = decisionItem({ state: 'superseded', question: 'Which queue?', choice: 'BullMQ' });
    const middle = mintId('Decision');
    const newest = mintId('Decision');
    const { posted } = serve({ decisions: [older] }, {});
    server.use(
      http.get(daemonUrl(`/decisions/${older.id}/provenance`), () =>
        HttpResponse.json(
          provenanceDto({
            id: older.id,
            kind: 'decision',
            state: 'superseded',
            supersededBy: middle,
            supersededByText: 'Which queue? → Graphile',
          }),
        ),
      ),
      http.get(daemonUrl(`/decisions/${middle}/provenance`), () =>
        HttpResponse.json(
          provenanceDto({
            id: middle,
            kind: 'decision',
            state: 'superseded',
            supersededBy: newest,
            supersededByText: 'Which queue? → pg-boss',
          }),
        ),
      ),
      http.get(daemonUrl(`/decisions/${newest}/provenance`), () =>
        HttpResponse.json(provenanceDto({ id: newest, kind: 'decision', state: 'current' })),
      ),
    );
    await openDecisions();
    await chooseShelf('Past');
    await openRowMenu('Actions for "Which queue?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    expect(await within(dialog).findByText(/has a newer version/)).toBeTruthy();
    expect(await within(dialog).findByText('Which queue? → pg-boss')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Reason')).toBeNull();
    expect(posted).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Newest Version' }));
    // The newest version's own dialog replaces this one.
    const reasonDialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    expect(
      await within(reasonDialog).findByText(
        /“Which queue\? → pg-boss” leaves briefings and search/,
      ),
    ).toBeTruthy();
    await dryRunAnswered(reasonDialog);
    fireEvent.change(within(reasonDialog).getByLabelText('Reason'), {
      target: { value: 'Rolled back' },
    });
    fireEvent.click(within(reasonDialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(posted).toEqual([
        { path: `/decisions/${newest}/withdraw`, body: { reason: 'Rolled back' } },
      ]);
    });
  });

  it('says nothing is left to withdraw when the newest version is retired', async () => {
    const older = decisionItem({ state: 'superseded', question: 'Which queue?', choice: 'BullMQ' });
    const newest = mintId('Decision');
    const { posted } = serve({ decisions: [older] });
    server.use(
      http.get(daemonUrl(`/decisions/${older.id}/provenance`), () =>
        HttpResponse.json(
          provenanceDto({
            id: older.id,
            kind: 'decision',
            state: 'superseded',
            supersededBy: newest,
            supersededByText: 'Which queue? → Graphile',
          }),
        ),
      ),
      http.get(daemonUrl(`/decisions/${newest}/provenance`), () =>
        HttpResponse.json(provenanceDto({ id: newest, kind: 'decision', state: 'retired' })),
      ),
    );
    await openDecisions();
    await chooseShelf('Past');
    await openRowMenu('Actions for "Which queue?"', 'Remove');
    const dialog = await screen.findByRole('dialog', { name: 'Remove Decision' });
    expect(await within(dialog).findByText(/has a newer version/)).toBeTruthy();
    expect(
      await within(dialog).findByText(
        /The newest version is retired, so there is nothing left to remove/,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText('Which queue? → Graphile')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Remove Newest Version' })).toBeNull();
    expect(within(dialog).queryByLabelText('Reason')).toBeNull();
    expect(posted).toEqual([]);
  });
});

describe('proposals', () => {
  it('accepts a proposal after changing its statement, kind and scope', async () => {
    const { posted, inboxReads } = serve(
      { proposals: [proposalDto({ projectId: project.id })] },
      { 'accept-dry-run': replacesNothing },
    );
    renderApp('/knowledge');
    await chooseShelf(/^Pending/);
    await waitFor(() => {
      expect(inboxReads.count).toBeGreaterThan(0);
    });
    const before = inboxReads.count;
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept Proposal' });
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('Statement').value).toBe(
      'Never sleep in tests',
    );
    fireEvent.change(within(dialog).getByLabelText('Statement'), {
      target: { value: 'Tests never sleep' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Preference/ }));
    await choose(dialog, 'Applies to', 'All Projects');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept' }));
    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]?.path).toMatch(/^\/proposals\/prp_.+\/accept$/);
    expect(posted[0]?.body).toEqual({
      scope: 'you',
      statement: 'Tests never sleep',
      kind: 'heuristic',
      topicKey: 'testing.no-sleeps',
    });
    // The verdict closes the card in the Inbox, so the Inbox is read again.
    await waitFor(() => {
      expect(inboxReads.count).toBeGreaterThan(before);
    });
  });

  it('rejects a proposal with a note, or without one', async () => {
    const { posted } = serve({ proposals: [proposalDto({ projectId: project.id })] });
    renderApp('/knowledge');
    await chooseShelf(/^Pending/);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject Proposal' });
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), {
      target: { value: 'Too strict' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]?.body).toEqual({ note: 'Too strict' });

    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const again = await screen.findByRole('dialog', { name: 'Reject Proposal' });
    fireEvent.click(within(again).getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(posted).toHaveLength(2);
    });
    expect(posted[1]?.body).toEqual({});
  });

  it('says so when the proposal was already decided elsewhere', async () => {
    serve(
      { proposals: [proposalDto({ projectId: project.id })] },
      {
        accept: refusal(409, 'Proposal prp_x is already accepted'),
        'accept-dry-run': replacesNothing,
      },
    );
    renderApp('/knowledge');
    await chooseShelf(/^Pending/);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept Proposal' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept' }));
    expect(await within(dialog).findByText('Proposal prp_x is already accepted')).toBeTruthy();
  });

  it('leaves a proposal that is not a principle to the Inbox', async () => {
    serve({
      proposals: [proposalDto({ projectId: project.id, kind: 'note', principle: null })],
    });
    renderApp('/knowledge');
    await chooseShelf(/^Pending/);
    expect(await screen.findByText('No proposals wait for you.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
});

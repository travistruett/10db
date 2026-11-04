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
  knowledgeList,
  principleItem,
  proposalDto,
  provenanceDto,
} from '../../test/knowledge-fixtures';

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
  const inboxReads = { count: 0 };
  const write =
    (route: string, fallback: Reply) =>
    async ({ request }: { request: Request }) => {
      const body: unknown = await request.json();
      posted.push({ path: new URL(request.url).pathname, body });
      const out = (replies[route] ?? fallback)(body);
      return HttpResponse.json(out.json, { status: out.status });
    };
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/knowledge'), ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind');
      return HttpResponse.json(
        knowledgeList(kind === 'decision' ? served.decisions : served.principles),
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
  return { served, posted, inboxReads };
}

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
    await choose(dialog, 'Applies to', 'Area: api');
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

  it('writes a principle for You, with a key made from its statement until the key is edited', async () => {
    const { posted } = serve();
    renderApp('/knowledge');
    fireEvent.click(await screen.findByRole('button', { name: 'New Principle' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Principle' });
    fireEvent.change(within(dialog).getByLabelText('Statement'), {
      target: { value: 'Prefer small pull requests' },
    });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Topic key').value).toBe(
      'prefer-small-pull-requests',
    );
    fireEvent.change(within(dialog).getByLabelText('Topic key'), {
      target: { value: 'prs.small' },
    });
    fireEvent.change(within(dialog).getByLabelText('Statement'), {
      target: { value: 'Prefer small PRs' },
    });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Topic key').value).toBe('prs.small');
    await choose(dialog, 'Kind', 'Policy');
    await choose(dialog, 'Applies to', 'You, in every project');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(posted).toEqual([
        {
          path: `/projects/${project.id}/principles`,
          body: {
            scope: 'you',
            statement: 'Prefer small PRs',
            kind: 'policy',
            topicKey: 'prs.small',
          },
        },
      ]);
    });
    expect(await screen.findByText('Prefer small PRs')).toBeTruthy();
  });

  it('refuses a topic key that is not one, without writing', async () => {
    const { posted } = serve();
    renderApp('/knowledge');
    fireEvent.click(await screen.findByRole('button', { name: 'New Principle' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Principle' });
    fireEvent.change(within(dialog).getByLabelText('Statement'), { target: { value: 'A rule' } });
    fireEvent.change(within(dialog).getByLabelText('Topic key'), {
      target: { value: 'Not A Key' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/lowercase words joined by/)).toBeTruthy();
    expect(posted).toEqual([]);
  });
});

describe('editing', () => {
  it('opens a decision with its text and scope, and saves a successor', async () => {
    const decision = decisionItem({ scope: 'area', area: 'api', projectId: project.id });
    const { posted } = serve({ decisions: [decision] });
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Edit…');
    const dialog = await screen.findByRole('dialog', { name: 'Edit Decision' });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Question').value).toBe(
      'Which queue library?',
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('Applies to').value).toBe('Area: api');
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
    await openRowMenu('Actions for testing.no-sleeps', 'Edit…');
    const dialog = await screen.findByRole('dialog', { name: 'Edit Principle' });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Topic key').value).toBe(
      'testing.no-sleeps',
    );
    fireEvent.change(within(dialog).getByLabelText('Statement'), {
      target: { value: 'Tests never sleep' },
    });
    await choose(dialog, 'Applies to', 'You, in every project');
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
    await openRowMenu('Actions for testing.no-sleeps', 'Edit…');
    const dialog = await screen.findByRole('dialog', { name: 'Edit Principle' });
    fireEvent.change(within(dialog).getByLabelText('Topic key'), {
      target: { value: 'prs.small' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(message)).toBeTruthy();
  });

  it('offers Edit only on a current record', async () => {
    serve({
      principles: [
        principleItem({ state: 'superseded', statement: 'Old rule', topicKey: 'old.rule' }),
      ],
    });
    renderApp('/knowledge');
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for old.rule' }));
    expect(await screen.findByRole('menuitem', { name: 'Withdraw…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Edit…' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Retire…' })).toBeNull();
  });
});

describe('retiring and withdrawing', () => {
  it('asks for a reason to withdraw a decision, and says where it goes', async () => {
    const decision = decisionItem({ projectId: project.id });
    const { posted } = serve({ decisions: [decision] });
    await openDecisions();
    await openRowMenu('Actions for "Which queue library?"', 'Withdraw…');
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw Decision' });
    expect(
      within(dialog).getByText(
        /leaves briefings and search\. It stays under History with your reason\./,
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    expect(await within(dialog).findByText('Say why.')).toBeTruthy();
    expect(posted).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Recorded by mistake' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => {
      expect(posted).toEqual([
        { path: `/decisions/${decision.id}/withdraw`, body: { reason: 'Recorded by mistake' } },
      ]);
    });
  });

  it('retires a principle with a reason', async () => {
    const principle = principleItem({ projectId: project.id });
    const { posted } = serve({ principles: [principle] });
    renderApp('/knowledge');
    await openRowMenu('Actions for testing.no-sleeps', 'Retire…');
    const dialog = await screen.findByRole('dialog', { name: 'Retire Principle' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retire' }));
    expect(await within(dialog).findByText('Say why.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Fake timers now' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retire' }));
    await waitFor(() => {
      expect(posted).toEqual([
        { path: `/principles/${principle.id}/retire`, body: { reason: 'Fake timers now' } },
      ]);
    });
  });

  it('withdraws a principle with a reason', async () => {
    const principle = principleItem({ projectId: project.id });
    const { posted } = serve({ principles: [principle] });
    renderApp('/knowledge');
    await openRowMenu('Actions for testing.no-sleeps', 'Withdraw…');
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw Principle' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Wrong repo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
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
    await openRowMenu('Actions for "Which queue library?"', 'Withdraw…');
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw Decision' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Oops' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
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
    fireEvent.click(await screen.findByRole('switch', { name: 'History' }));
    await openRowMenu('Actions for "Which queue?"', 'Withdraw…');
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw Decision' });
    expect(await within(dialog).findByText(/has a newer version/)).toBeTruthy();
    expect(await within(dialog).findByText('Which queue? → pg-boss')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Reason')).toBeNull();
    expect(posted).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw Newest Version' }));
    // The newest version's own dialog replaces this one.
    const reasonDialog = await screen.findByRole('dialog', { name: 'Withdraw Decision' });
    expect(
      await within(reasonDialog).findByText(
        /“Which queue\? → pg-boss” leaves briefings and search/,
      ),
    ).toBeTruthy();
    fireEvent.change(within(reasonDialog).getByLabelText('Reason'), {
      target: { value: 'Rolled back' },
    });
    fireEvent.click(within(reasonDialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => {
      expect(posted).toEqual([
        { path: `/decisions/${newest}/withdraw`, body: { reason: 'Rolled back' } },
      ]);
    });
  });
});

describe('proposals', () => {
  it('accepts a proposal after changing its statement, kind and scope', async () => {
    const { posted, inboxReads } = serve({ proposals: [proposalDto({ projectId: project.id })] });
    renderApp('/knowledge');
    fireEvent.click(await screen.findByRole('tab', { name: /^Proposals/ }));
    await waitFor(() => {
      expect(inboxReads.count).toBeGreaterThan(0);
    });
    const before = inboxReads.count;
    fireEvent.click(await screen.findByRole('button', { name: 'Accept…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept Proposal' });
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('Statement').value).toBe(
      'Never sleep in tests',
    );
    fireEvent.change(within(dialog).getByLabelText('Statement'), {
      target: { value: 'Tests never sleep' },
    });
    await choose(dialog, 'Kind', 'Heuristic');
    await choose(dialog, 'Applies to', 'You, in every project');
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
    fireEvent.click(await screen.findByRole('tab', { name: /^Proposals/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject Proposal' });
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), {
      target: { value: 'Too strict' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]?.body).toEqual({ note: 'Too strict' });

    fireEvent.click(await screen.findByRole('button', { name: 'Reject…' }));
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
      { accept: refusal(409, 'Proposal prp_x is already accepted') },
    );
    renderApp('/knowledge');
    fireEvent.click(await screen.findByRole('tab', { name: /^Proposals/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept Proposal' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept' }));
    expect(await within(dialog).findByText('Proposal prp_x is already accepted')).toBeTruthy();
  });

  it('leaves a proposal that is not a principle to the Inbox', async () => {
    serve({
      proposals: [proposalDto({ projectId: project.id, kind: 'note', principle: null })],
    });
    renderApp('/knowledge');
    fireEvent.click(await screen.findByRole('tab', { name: /^Proposals/ }));
    expect(await screen.findByRole('table', { name: 'Proposals' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept…' })).toBeNull();
  });
});

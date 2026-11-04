import { mintId, type DecisionItem, type PrincipleItem, type ProposalDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { daemonEvent, projectViewDto } from '../../test/fixtures';
import {
  decisionItem,
  knowledgeList,
  principleItem,
  proposalDto,
  provenanceDto,
} from '../../test/knowledge-fixtures';

const project = projectViewDto({
  areas: [
    { name: 'api', globs: ['src/api/**'] },
    { name: 'ui', globs: ['src/ui/**'] },
  ],
});

interface Served {
  principles: PrincipleItem[];
  decisions: DecisionItem[];
  proposals: ProposalDto[];
}

/** Serves one project's knowledge and records every list request's query string. */
function serve(data: Partial<Served> = {}) {
  const served: Served = { principles: [], decisions: [], proposals: [], ...data };
  const asked: URLSearchParams[] = [];
  const sockets: { send(data: string): void }[] = [];
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/knowledge'), ({ request }) => {
      const params = new URL(request.url).searchParams;
      asked.push(params);
      const items = params.get('kind') === 'decision' ? served.decisions : served.principles;
      return HttpResponse.json(knowledgeList(items));
    }),
    http.get(daemonUrl('/projects/:projectId/proposals'), () =>
      HttpResponse.json(served.proposals),
    ),
    eventStream.addEventListener('connection', ({ client }) => {
      sockets.push(client);
    }),
    ...baseHandlers(),
  );
  return { asked, served, sockets };
}

async function chooseScope(name: string) {
  const input = (await screen.findAllByLabelText('Scope')).find((el) => el.tagName === 'INPUT');
  if (!input) throw new Error('no scope filter');
  fireEvent.click(input);
  const id = input.getAttribute('aria-controls');
  const list = await waitFor(() => {
    const el = id === null ? null : document.getElementById(id);
    expect(el).not.toBeNull();
    return el ?? document.body;
  });
  fireEvent.click(within(list).getByRole('option', { name, hidden: true }));
}

describe('KnowledgeView', () => {
  it('is in the navigation between Inbox and Settings', async () => {
    serve();
    renderApp('/knowledge');
    const links = (await screen.findAllByRole('link')).map((l) => l.textContent);
    expect(links.indexOf('Knowledge')).toBeGreaterThan(links.indexOf('Inbox'));
    expect(links.indexOf('Knowledge')).toBeLessThan(links.indexOf('Settings'));
    expect(await screen.findByRole('heading', { name: 'Knowledge', level: 2 })).toBeTruthy();
  });

  it('lists principles, policies first, with scope, kind and date, for the chosen project', async () => {
    const { asked } = serve({
      principles: [
        principleItem({
          statement: 'Prefer small PRs',
          principleKind: 'heuristic',
          topicKey: 'prs.small',
          scope: 'you',
          projectId: null,
          createdAt: '2026-09-01T10:00:00.000Z',
        }),
        principleItem({
          statement: 'Never sleep in tests',
          scope: 'area',
          area: 'api',
          createdAt: '2026-10-13T12:00:00.000Z',
        }),
      ],
    });
    renderApp('/knowledge');
    const table = await screen.findByRole('table', { name: 'Principles' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] ?? table).getByText('Never sleep in tests')).toBeTruthy();
    expect(within(rows[0] ?? table).getByText('api')).toBeTruthy();
    expect(within(rows[0] ?? table).getByText('Policy')).toBeTruthy();
    expect(within(rows[0] ?? table).getByText('13 Oct 2026')).toBeTruthy();
    expect(within(rows[1] ?? table).getByText('Prefer small PRs')).toBeTruthy();
    expect(within(rows[1] ?? table).getByText('You')).toBeTruthy();
    expect(within(rows[1] ?? table).getByText('Heuristic')).toBeTruthy();
    expect(asked.at(-1)?.get('kind')).toBe('principle');
  });

  it('searches as you type', async () => {
    const { asked } = serve({ principles: [principleItem()] });
    renderApp('/knowledge');
    await screen.findByRole('table', { name: 'Principles' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: 'sleep' },
    });
    await waitFor(() => {
      expect(asked.at(-1)?.get('q')).toBe('sleep');
    });
  });

  it('says so when search is unavailable instead of reporting nothing found', async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/knowledge'), () =>
        HttpResponse.json(
          knowledgeList([], { search: { available: false, message: 'Search is unavailable: x' } }),
        ),
      ),
      http.get(daemonUrl('/projects/:projectId/proposals'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderApp('/knowledge');
    expect(await screen.findByText('Search is unavailable: x')).toBeTruthy();
  });

  it('filters by You, Project or one area, and shows history with each record’s state', async () => {
    const { asked } = serve({
      principles: [
        principleItem({ state: 'superseded', statement: 'Old rule' }),
        principleItem({ state: 'retired', statement: 'Retired rule' }),
        principleItem({ state: 'withdrawn', statement: 'Typo rule' }),
      ],
    });
    renderApp('/knowledge');
    await screen.findByRole('table', { name: 'Principles' });
    expect(asked.at(-1)?.get('history')).toBe('0');
    await chooseScope('api');
    await waitFor(() => {
      expect(asked.at(-1)?.get('scope')).toBe('area');
    });
    expect(asked.at(-1)?.get('area')).toBe('api');
    await chooseScope('You');
    await waitFor(() => {
      expect(asked.at(-1)?.get('scope')).toBe('you');
    });
    expect(asked.at(-1)?.get('area')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'History' }));
    await waitFor(() => {
      expect(asked.at(-1)?.get('history')).toBe('1');
    });
    const table = await screen.findByRole('table', { name: 'Principles' });
    expect(within(table).getByText('Superseded')).toBeTruthy();
    expect(within(table).getByText('Retired')).toBeTruthy();
    expect(within(table).getByText('Withdrawn')).toBeTruthy();
  });

  it('lists decisions on their own tab', async () => {
    serve({
      decisions: [
        decisionItem({ scope: 'area', area: 'ui', question: 'Which icons?', choice: 'Tabler' }),
      ],
    });
    renderApp('/knowledge');
    fireEvent.click(await screen.findByRole('tab', { name: 'Decisions' }));
    const table = await screen.findByRole('table', { name: 'Decisions' });
    expect(within(table).getByText('Which icons?')).toBeTruthy();
    expect(within(table).getByText('Tabler')).toBeTruthy();
    expect(within(table).getByText('ui')).toBeTruthy();
    expect(within(table).getByText('13 Oct 2026')).toBeTruthy();
  });

  it('counts pending proposals on their tab and shows what each proposes', async () => {
    serve({ proposals: [proposalDto()] });
    renderApp('/knowledge');
    fireEvent.click(await screen.findByRole('tab', { name: /^Proposals\s*1$/ }));
    expect(await screen.findByText('No sleeps in tests')).toBeTruthy();
    expect(screen.getByText('Never sleep in tests')).toBeTruthy();
    expect(screen.getByText('Two flaky runs came from sleeps.')).toBeTruthy();
    expect(screen.getByText('Proposed')).toBeTruthy();
  });

  it('shows where a principle came from, with what it replaced', async () => {
    const principle = principleItem({ speaker: 'agent:ses_1', topicKey: 'testing.no-sleeps' });
    const before = mintId('Principle');
    serve({ principles: [principle] });
    server.use(
      http.get(daemonUrl(`/principles/${principle.id}/provenance`), () =>
        HttpResponse.json(
          provenanceDto({
            id: principle.id,
            sourceKind: 'inbox_answer',
            by: 'me',
            inbox: {
              id: mintId('InboxItem'),
              title: 'Should tests sleep?',
              choice: 'Never',
              note: 'It made the suite flaky',
            },
            quote: 'sleeping made the suite flaky',
            confirmedBy: 'me',
            confirmedAt: '2026-10-14T12:00:00.000Z',
            supersedes: before,
          }),
        ),
      ),
    );
    renderApp('/knowledge');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Where Never sleep in tests came from' }),
    );
    const drawer = await screen.findByRole('dialog', { name: 'Where it came from' });
    expect(await within(drawer).findByText('Inbox answer')).toBeTruthy();
    expect(within(drawer).getByText('Should tests sleep?')).toBeTruthy();
    expect(within(drawer).getByText('Answer: Never')).toBeTruthy();
    expect(within(drawer).getByText('sleeping made the suite flaky')).toBeTruthy();
    expect(within(drawer).getByText(/^Recorded 13 Oct 2026, \d\d:\d\d by you$/)).toBeTruthy();
    expect(within(drawer).getByText(/Confirmed by you on 14 Oct 2026/)).toBeTruthy();
    expect(within(drawer).getByText(`Replaced ${before}`)).toBeTruthy();
  });

  it.each([
    ['agent', {}, 'Agent'],
    ['builder', { sourceRef: { shapeId: 'shp_1' } }, 'Plan conversation'],
    ['builder', { origin: { via: 'claude_code', sessionId: null, cwd: null } }, 'Claude Code'],
    ['builder', {}, 'The app'],
  ] as const)('names a %s source %j as %s', async (sourceKind, extra, label) => {
    const decision = decisionItem({ question: 'Which queue library?' });
    serve({ decisions: [decision] });
    server.use(
      http.get(daemonUrl(`/decisions/${decision.id}/provenance`), () =>
        HttpResponse.json(
          provenanceDto({
            id: decision.id,
            kind: 'decision',
            sourceKind,
            ...extra,
            withdrawn: {
              at: '2026-10-15T12:00:00.000Z',
              by: 'me',
              reason: 'Wrong repo',
              source: null,
            },
            state: 'withdrawn',
            supersededBy: mintId('Decision'),
          }),
        ),
      ),
    );
    renderApp('/knowledge');
    fireEvent.click(await screen.findByRole('tab', { name: 'Decisions' }));
    fireEvent.click(await screen.findByRole('button', { name: /Where .* came from/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Where it came from' });
    expect(await within(drawer).findByText(label)).toBeTruthy();
    expect(within(drawer).getByText(/Withdrawn by you on 15 Oct 2026/)).toBeTruthy();
    expect(within(drawer).getByText('Wrong repo')).toBeTruthy();
    expect(within(drawer).getByText(/Replaced by dec_/)).toBeTruthy();
  });

  it('shows a record written elsewhere without a reload', async () => {
    const { served, sockets } = serve({ principles: [principleItem()] });
    renderApp('/knowledge');
    await screen.findByText('Never sleep in tests');
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    served.principles = [
      principleItem({ statement: 'Written by a lane', topicKey: 'lane.rule' }),
      ...served.principles,
    ];
    sockets[0]?.send(
      JSON.stringify(
        daemonEvent({ seq: 1, type: 'principle.saved', entityType: 'principle', data: {} }),
      ),
    );
    expect(await screen.findByText('Written by a lane')).toBeTruthy();
  });
});

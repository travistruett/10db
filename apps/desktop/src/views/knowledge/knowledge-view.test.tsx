import {
  mintId,
  type DecisionItem,
  type KnowledgeScope,
  type PrincipleItem,
  type ProposalDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
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

  it('lists principles, policies first, with scope, kind and date', async () => {
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

  it('keeps the listed rows on screen while a changed filter loads', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/knowledge'), async ({ request }) => {
        calls += 1;
        if (new URL(request.url).searchParams.has('q')) await gate;
        return HttpResponse.json(knowledgeList([principleItem({ statement: 'Prefer small PRs' })]));
      }),
      http.get(daemonUrl('/projects/:projectId/proposals'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderApp('/knowledge');
    await screen.findByRole('table', { name: 'Principles' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: 'sleep' },
    });
    await waitFor(() => {
      expect(calls).toBeGreaterThan(1);
    });
    expect(screen.getByRole('table', { name: 'Principles' })).toBeTruthy();
    expect(screen.queryByLabelText('Loading principles')).toBeNull();
    release();
    await waitFor(() => {
      expect(screen.getByRole('table', { name: 'Principles' })).toBeTruthy();
    });
  });

  it('stops the search box at the 200 characters the route accepts', async () => {
    serve({ principles: [principleItem()] });
    renderApp('/knowledge');
    await screen.findByRole('table', { name: 'Principles' });
    expect(screen.getByRole('textbox', { name: 'Search' }).getAttribute('maxlength')).toBe('200');
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
    expect(screen.queryByText(/match\./)).toBeNull();
  });

  it('says so with a search and does not read the empty answer as no match', async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/knowledge'), ({ request }) => {
        const searched = new URL(request.url).searchParams.has('q');
        return HttpResponse.json(
          knowledgeList(searched ? [] : [principleItem()], {
            search: { available: false, message: 'Search is unavailable: x' },
          }),
        );
      }),
      http.get(daemonUrl('/projects/:projectId/proposals'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderApp('/knowledge');
    await screen.findByRole('table', { name: 'Principles' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: 'sleep' },
    });
    expect(await screen.findByText('Search is unavailable: x')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('table', { name: 'Principles' })).toBeNull();
    });
    expect(screen.queryByText('No principles match.')).toBeNull();
  });

  it('still lists the records without a search when search is unavailable', async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/knowledge'), () =>
        HttpResponse.json(
          knowledgeList([principleItem({ statement: 'Prefer small PRs' })], {
            search: { available: false, message: 'Search is unavailable: x' },
          }),
        ),
      ),
      http.get(daemonUrl('/projects/:projectId/proposals'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderApp('/knowledge');
    expect(await screen.findByText('Prefer small PRs')).toBeTruthy();
    expect(screen.getByText('Search is unavailable: x')).toBeTruthy();
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
    expect(within(table).getByText('Current')).toBeTruthy();
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

  describe('on the Proposals tab', () => {
    /** A principle proposal for one place. */
    const placed = (
      title: string,
      place: { scope: KnowledgeScope; area: string | null },
      body = 'Agreed in review.',
    ): ProposalDto => {
      const proposal = proposalDto({ title, body });
      if (proposal.principle === null) throw new Error('the fixture proposes a principle');
      return { ...proposal, principle: { ...proposal.principle, ...place } };
    };
    const proposals = [
      placed('Mine', { scope: 'you', area: null }),
      placed('Whole project', { scope: 'project', area: null }, 'Mentions the deploy freeze.'),
      placed('For the api', { scope: 'area', area: 'api' }),
      placed('For the ui', { scope: 'area', area: 'ui' }),
      proposalDto({ kind: 'note', title: 'A note', body: 'b', principle: null }),
    ];

    const shown = (): (string | undefined)[] => {
      const table = screen.queryByRole('table', { name: 'Proposals' });
      if (table === null) return [];
      return within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.querySelector('p')?.textContent);
    };

    async function openProposals() {
      fireEvent.click(await screen.findByRole('tab', { name: /^Proposals/ }));
      await waitFor(() => {
        expect(shown()).toHaveLength(proposals.length);
      });
    }

    it('narrows to the proposals matching every word typed', async () => {
      serve({ proposals });
      renderApp('/knowledge');
      await openProposals();
      fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
        target: { value: 'FREEZE deploy' },
      });
      await waitFor(() => {
        expect(shown()).toEqual(['Whole project']);
      });
      fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
        target: { value: 'nothing says this' },
      });
      expect(await screen.findByText('No proposal matches.')).toBeTruthy();
    });

    it('finds a proposal from a partly typed word, but not from the middle of one', async () => {
      serve({ proposals });
      renderApp('/knowledge');
      await openProposals();
      fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
        target: { value: 'dep free' },
      });
      await waitFor(() => {
        expect(shown()).toEqual(['Whole project']);
      });
      fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
        target: { value: 'eeze' },
      });
      expect(await screen.findByText('No proposal matches.')).toBeTruthy();
    });

    it('reads a search with no word as no search on every tab', async () => {
      const { asked } = serve({ proposals });
      renderApp('/knowledge');
      expect(await screen.findByText(/^No principles yet/)).toBeTruthy();
      fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
        target: { value: '-' },
      });
      await waitFor(() => {
        expect(asked.at(-1)?.get('q')).toBe('-');
      });
      expect(await screen.findByText(/^No principles yet/)).toBeTruthy();
      expect(screen.queryByText('No principles match.')).toBeNull();
      fireEvent.click(screen.getByRole('tab', { name: 'Decisions' }));
      expect(await screen.findByText(/^No decisions yet/)).toBeTruthy();
      expect(screen.queryByText('No decisions match.')).toBeNull();
      await openProposals();
    });

    it('narrows to You, Project or one area, and counts anything but a principle as Project', async () => {
      serve({ proposals });
      renderApp('/knowledge');
      await openProposals();
      await chooseScope('You');
      await waitFor(() => {
        expect(shown()).toEqual(['Mine']);
      });
      await chooseScope('Project');
      await waitFor(() => {
        expect(shown()).toEqual(['Whole project', 'A note']);
      });
      await chooseScope('api');
      await waitFor(() => {
        expect(shown()).toEqual(['For the api']);
      });
    });
  });

  describe('with two projects', () => {
    const alpha = projectViewDto({ name: 'alpha', repoPath: '/Users/x/a' });
    const beta = projectViewDto({ name: 'beta', repoPath: '/Users/x/b' });

    afterEach(() => {
      window.localStorage.clear();
    });

    /** Each project answers with its own records, and every read is noted with the project it asked for. */
    function serveBoth() {
      const asked: { projectId: string; path: string; params: URLSearchParams }[] = [];
      const note = (request: Request, projectId: unknown): void => {
        const url = new URL(request.url);
        asked.push({ projectId: String(projectId), path: url.pathname, params: url.searchParams });
      };
      server.use(
        http.get(daemonUrl('/projects'), () => HttpResponse.json([alpha, beta])),
        http.get(daemonUrl('/projects/:projectId/knowledge'), ({ request, params }) => {
          note(request, params['projectId']);
          const statement = params['projectId'] === alpha.id ? 'Alpha rule' : 'Beta rule';
          return HttpResponse.json(knowledgeList([principleItem({ statement })]));
        }),
        http.get(daemonUrl('/projects/:projectId/proposals'), ({ request, params }) => {
          note(request, params['projectId']);
          return HttpResponse.json([]);
        }),
        ...baseHandlers(),
      );
      return asked;
    }

    it('reads the knowledge and proposals of the stored project', async () => {
      window.localStorage.setItem('tendb.project', JSON.stringify(beta.id));
      const asked = serveBoth();
      renderApp('/knowledge');
      expect(await screen.findByText('Beta rule')).toBeTruthy();
      await waitFor(() => {
        expect(asked.some((a) => a.path.endsWith('/proposals'))).toBe(true);
      });
      expect(asked.some((a) => a.path.endsWith('/knowledge'))).toBe(true);
      expect(asked.every((a) => a.projectId === beta.id)).toBe(true);
    });

    it('follows the switcher and starts the new project’s view afresh', async () => {
      const asked = serveBoth();
      renderApp('/knowledge');
      expect(await screen.findByText('Alpha rule')).toBeTruthy();
      fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
        target: { value: 'rule' },
      });
      fireEvent.click(screen.getByRole('switch', { name: 'History' }));
      await waitFor(() => {
        expect(asked.at(-1)?.params.get('q')).toBe('rule');
      });
      fireEvent.click(screen.getByRole('tab', { name: 'Decisions' }));
      await waitFor(() => {
        expect(asked.at(-1)?.params.get('kind')).toBe('decision');
      });

      asked.length = 0;
      fireEvent.click(screen.getByRole('button', { name: 'Project: alpha. Switch project' }));
      fireEvent.click(await screen.findByRole('option', { name: /beta/, hidden: true }));

      expect(await screen.findByText('Beta rule')).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Principles' }).getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(screen.getByRole('textbox', { name: 'Search' })).toHaveProperty('value', '');
      expect(screen.getByRole('switch', { name: 'History' })).toHaveProperty('checked', false);
      const list = asked.filter((a) => a.path.endsWith('/knowledge'));
      expect(list.every((a) => a.projectId === beta.id)).toBe(true);
      expect(list.at(-1)?.params.get('q') ?? '').toBe('');
      expect(list.at(-1)?.params.get('history')).toBe('0');
      await waitFor(() => {
        expect(asked.some((a) => a.path.endsWith('/proposals'))).toBe(true);
      });
      expect(asked.every((a) => a.projectId === beta.id)).toBe(true);
    });
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
            supersedesText: 'Sleep when you must',
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
    expect(
      within(drawer).getByRole('button', { name: 'Replaced: Sleep when you must' }),
    ).toBeTruthy();
    expect(drawer.textContent).not.toContain(before);
  });

  it('follows a replaced record, naming it by its words', async () => {
    const principle = principleItem({ statement: 'Never sleep in tests' });
    const before = mintId('Principle');
    serve({ principles: [principle] });
    server.use(
      http.get(daemonUrl(`/principles/${principle.id}/provenance`), () =>
        HttpResponse.json(
          provenanceDto({
            id: principle.id,
            supersedes: before,
            supersedesText: 'Sleep when you must',
          }),
        ),
      ),
      http.get(daemonUrl(`/principles/${before}/provenance`), () =>
        HttpResponse.json(
          provenanceDto({
            id: before,
            state: 'superseded',
            supersededBy: principle.id,
            supersededByText: 'Never sleep in tests',
          }),
        ),
      ),
    );
    renderApp('/knowledge');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Where Never sleep in tests came from' }),
    );
    const drawer = await screen.findByRole('dialog', { name: 'Where it came from' });
    fireEvent.click(
      await within(drawer).findByRole('button', { name: 'Replaced: Sleep when you must' }),
    );
    expect(
      await within(drawer).findByRole('button', { name: 'Replaced by: Never sleep in tests' }),
    ).toBeTruthy();
    expect(within(drawer).getByText('Sleep when you must')).toBeTruthy();
    expect(drawer.textContent).not.toContain(before);
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
            supersededByText: 'Which queue library? → pg-boss',
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
    expect(
      within(drawer).getByRole('button', {
        name: 'Replaced by: Which queue library? → pg-boss',
      }),
    ).toBeTruthy();
  });

  it('shows who retired a principle, when and why', async () => {
    const principle = principleItem({ state: 'retired', statement: 'Retired rule' });
    serve({ principles: [principle] });
    server.use(
      http.get(daemonUrl(`/principles/${principle.id}/provenance`), () =>
        HttpResponse.json(
          provenanceDto({
            id: principle.id,
            state: 'retired',
            retired: {
              at: '2026-10-16T09:30:00.000Z',
              by: 'agent:claude',
              reason: 'We use fake timers now',
              source: null,
            },
          }),
        ),
      ),
    );
    renderApp('/knowledge');
    fireEvent.click(await screen.findByRole('button', { name: /Where .* came from/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Where it came from' });
    expect(await within(drawer).findByText(/Retired by an agent on 16 Oct 2026/)).toBeTruthy();
    expect(within(drawer).getByText('We use fake timers now')).toBeTruthy();
  });

  describe('names the tool behind a retire, withdrawal or confirmation', () => {
    const at = '2026-10-16T09:30:00.000Z';
    it.each([
      ['claude_code', 'Claude Code'],
      ['builder_mcp', 'Claude Code'],
      ['some_other_tool', 'some_other_tool'],
    ])('through %s reads "through %s"', async (via, name) => {
      const principle = principleItem({ state: 'retired', statement: 'Retired rule' });
      serve({ principles: [principle] });
      const source = { via, sessionId: null, cwd: null, recordedAt: at, quote: null };
      server.use(
        http.get(daemonUrl(`/principles/${principle.id}/provenance`), () =>
          HttpResponse.json(
            provenanceDto({
              id: principle.id,
              state: 'retired',
              confirmedBy: 'me',
              confirmedAt: at,
              confirmedSource: source,
              retired: { at, by: 'me', reason: 'Old', source },
              withdrawn: { at, by: 'me', reason: 'Wrong', source },
            }),
          ),
        ),
      );
      renderApp('/knowledge');
      fireEvent.click(await screen.findByRole('button', { name: /Where .* came from/ }));
      const drawer = await screen.findByRole('dialog', { name: 'Where it came from' });
      for (const verb of ['Retired', 'Withdrawn', 'Confirmed']) {
        expect(
          await within(drawer).findByText(new RegExp(`^${verb} by you on .* through ${name}$`)),
        ).toBeTruthy();
      }
    });
  });

  describe('names the session that wrote a record', () => {
    const shapeId = mintId('Shape');
    const workstreamId = mintId('Workstream');
    const shapeSession = { workstreamId: null, shapeId, taskTitle: null };
    const laneSession = { workstreamId, shapeId: null, shapeTitle: null };

    it.each([
      [
        'a Shape session by its title',
        { ...shapeSession, shapeTitle: 'Density' },
        'Plan conversation: Density',
      ],
      [
        'a Shape session with no title by its id',
        { ...shapeSession, shapeTitle: null },
        `Plan conversation: ${shapeId}`,
      ],
      ['a lane session by its task', { ...laneSession, taskTitle: 'Add retries' }, 'Add retries'],
      [
        'a lane session with no task by its workstream',
        { ...laneSession, taskTitle: null },
        workstreamId,
      ],
    ])('%s', async (_name, session, label) => {
      const principle = principleItem();
      serve({ principles: [principle] });
      server.use(
        http.get(daemonUrl(`/principles/${principle.id}/provenance`), () =>
          HttpResponse.json(
            provenanceDto({
              id: principle.id,
              sourceKind: 'agent',
              session: { id: mintId('Session'), ...session },
            }),
          ),
        ),
      );
      renderApp('/knowledge');
      fireEvent.click(
        await screen.findByRole('button', { name: 'Where Never sleep in tests came from' }),
      );
      const drawer = await screen.findByRole('dialog', { name: 'Where it came from' });
      expect(await within(drawer).findByText(label)).toBeTruthy();
    });
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

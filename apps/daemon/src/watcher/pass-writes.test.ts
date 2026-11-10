import { ClaimKind, mintId, type ProjectDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { accountedAt, passWrites, type PassLane } from './pass-writes';

// Workbench spec §6.4: what the watcher raises for a write in Your folder while a pass holds its tasks.

const PROJECT: Pick<ProjectDto, 'areas' | 'hazards'> = {
  areas: [
    { name: 'settings', globs: ['src/settings/**'] },
    { name: 'people', globs: ['src/people/**'] },
  ],
  hazards: [{ name: 'deps', globs: ['pnpm-lock.yaml'], commands: ['pnpm install'] }],
};

const lane = (title: string, area: string, working: boolean): PassLane => ({
  id: mintId('Workstream'),
  title,
  working,
  claims: [{ kind: ClaimKind.Area, name: area }],
});

const settingsReady = lane('Settings', 'settings', false);
const peopleReady = lane('People', 'people', false);
const peopleWorking = lane('People', 'people', true);

const rows: {
  readonly name: string;
  readonly lanes: readonly PassLane[];
  readonly strays: readonly string[];
  readonly foreign: readonly string[];
  readonly want: { strays: string[]; foreign: string[]; working: string[] };
}[] = [
  {
    name: "a hand edit to a Ready page's file raises no foreign-claim card",
    lanes: [settingsReady, peopleReady],
    strays: [],
    foreign: ['src/settings/page.tsx'],
    want: { strays: [], foreign: [], working: [] },
  },
  {
    name: "a write to a Ready page's file while another page works raises none either",
    lanes: [settingsReady, peopleWorking],
    strays: [],
    foreign: ['src/settings/page.tsx'],
    want: { strays: [], foreign: [], working: ['People'] },
  },
  {
    name: 'a write outside every claim while no lane works is the builder’s: no stray card',
    lanes: [settingsReady, peopleReady],
    strays: ['docs/notes.md'],
    foreign: [],
    want: { strays: [], foreign: [], working: [] },
  },
  {
    name: 'a write outside every claim while a lane works raises the stray card, naming it',
    lanes: [settingsReady, peopleWorking],
    strays: ['docs/notes.md'],
    foreign: [],
    want: { strays: ['docs/notes.md'], foreign: [], working: ['People'] },
  },
  {
    name: 'a write inside a claim no task of the pass holds is left to the foreign-claim check',
    lanes: [settingsReady],
    strays: [],
    foreign: ['pnpm-lock.yaml'],
    want: { strays: [], foreign: ['pnpm-lock.yaml'], working: [] },
  },
];

describe('passWrites', () => {
  it.each(rows)('$name', ({ lanes, strays, foreign, want }) => {
    const sorted = passWrites({ project: PROJECT, lanes, strays, foreign });
    expect({
      strays: sorted.strays,
      foreign: sorted.foreign,
      working: sorted.working.map((l) => l.title),
    }).toEqual(want);
  });
});

// Workbench spec §5.1, §7.2: the commit that holds what the pass accounts for at each path of Your folder.
const DIRT = 'refs/10db/passes/pas_1/dirt';
const change = (seq: number, sha: string, paths: string[]) => ({
  seq,
  sha,
  paths,
  blobs: Object.fromEntries(paths.map((path) => [path, `${sha}-blob`])),
});

const accountedRows: {
  readonly name: string;
  readonly dirt: readonly string[];
  readonly shared: readonly ReturnType<typeof change>[];
  readonly want: Record<string, string>;
}[] = [
  {
    name: 'a path of the dirt is held by the dirt commit',
    dirt: ['README.md'],
    shared: [],
    want: { 'README.md': DIRT },
  },
  {
    name: 'a shared change that set a path of the dirt holds it instead',
    dirt: ['src/kit/button.ts'],
    shared: [change(1, 'a1', ['src/kit/button.ts'])],
    want: { 'src/kit/button.ts': 'a1' },
  },
  {
    name: 'the newest change holds a path, whatever order the chain is read in',
    dirt: [],
    shared: [
      change(2, 'b2', ['src/kit/button.ts']),
      change(1, 'a1', ['src/kit/button.ts', 'src/kit/x.ts']),
    ],
    want: { 'src/kit/button.ts': 'b2', 'src/kit/x.ts': 'a1' },
  },
  {
    name: 'a drop that put a path back holds it',
    dirt: [],
    shared: [change(1, 'a1', ['src/kit/button.ts']), change(2, 'd2', ['src/kit/button.ts'])],
    want: { 'src/kit/button.ts': 'd2' },
  },
];

describe('accountedAt', () => {
  it.each(accountedRows)('$name', ({ dirt, shared, want }) => {
    expect(
      Object.fromEntries(
        [
          ...accountedAt({
            dirtRef: DIRT,
            dirt: dirt.map((path) => ({ path, blob: 'dirt-blob' })),
            shared,
          }),
        ].map(([path, { at, blob }]) => [path, `${at} ${String(blob)}`]),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(want).map(([path, at]) => [
          path,
          `${at} ${at === DIRT ? 'dirt-blob' : `${at}-blob`}`,
        ]),
      ),
    );
  });
});

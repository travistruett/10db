import { ClaimKind, mintId, type ProjectDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { passWrites, type PassLane } from './pass-writes';

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

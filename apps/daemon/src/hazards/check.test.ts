import { DEFAULT_HAZARDS } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { checkAssessment, staleAdditions, type CheckInput } from './check';

const MAKEFILE = [
  '.PHONY: gate migration backend-lock frontend-lock',
  'gate:',
  '\tmake lint',
  'migration:',
  '\tdocker compose run backend python manage.py makemigrations $(APP)',
  'backend-lock:',
  '\tdocker compose run backend uv lock',
  'frontend-lock:',
  '\tpnpm install --lockfile-only',
];
const AGENTS = [
  '# amps',
  'Run `make migration APP=x` to create a migration.',
  'Never hand-edit exports: use `python3 amps/dev_export.py --all`.',
  'CI runs `python manage.py makemigrations --check` for drift.',
];

const input = (over: Partial<CheckInput> = {}): CheckInput => ({
  tracked: [
    'Makefile',
    'amps/AGENTS.md',
    'amps/dev_export.py',
    'amps/backend/uv.lock',
    'amps/frontend/pnpm-lock.yaml',
    'amps/frontend/package.json',
    'amps/exports/a.json',
    ...Array.from({ length: 30 }, (_, i) => `amps/backend/app/mod${String(i)}.py`),
  ],
  lines: new Map([
    ['Makefile', MAKEFILE],
    ['amps/AGENTS.md', AGENTS],
  ]),
  hazards: DEFAULT_HAZARDS,
  areaNames: ['repo'],
  gateCommands: ['make gate'],
  kept: [],
  declined: [],
  ...over,
});

const reply = (value: unknown): string => `Here you go:\n${JSON.stringify(value)}`;

describe('checking what the model proposed', () => {
  it('keeps make targets and helper scripts that write lockfiles and migrations, with file and line', () => {
    const checked = checkAssessment(
      reply({
        additions: [
          {
            hazard: 'migrations',
            kind: 'command',
            value: 'make migration',
            reason: 'Creates a migration.',
            file: 'Makefile',
            line: 4,
          },
          {
            hazard: 'deps',
            kind: 'command',
            value: 'make backend-lock',
            reason: 'Locks the backend.',
            file: 'Makefile',
            line: 6,
          },
          {
            hazard: 'deps',
            kind: 'command',
            value: 'make frontend-lock',
            reason: 'Locks the frontend.',
            file: 'Makefile',
            line: 8,
          },
          {
            hazard: 'exports',
            kind: 'command',
            value: 'python3 amps/dev_export.py',
            reason: 'Rewrites the exports.',
            file: 'amps/AGENTS.md',
            line: 3,
          },
          {
            hazard: 'exports',
            kind: 'glob',
            value: 'amps/exports/**',
            reason: 'Exported data.',
            file: 'amps/exports/a.json',
          },
        ],
        removals: [],
      }),
      input(),
    );
    expect(checked?.additions.map((a) => [a.hazard, a.value, a.evidence])).toEqual([
      ['migrations', 'make migration', { file: 'Makefile', line: 4 }],
      ['deps', 'make backend-lock', { file: 'Makefile', line: 6 }],
      ['deps', 'make frontend-lock', { file: 'Makefile', line: 8 }],
      ['exports', 'python3 amps/dev_export.py', { file: 'amps/AGENTS.md', line: 3 }],
      ['exports', 'amps/exports/**', { file: 'amps/exports/a.json' }],
    ]);
  });

  it('drops read-only checks and the gate', () => {
    const checked = checkAssessment(
      reply({
        additions: [
          {
            hazard: 'migrations',
            kind: 'command',
            value: 'python manage.py makemigrations --check',
            reason: 'Drift.',
            file: 'amps/AGENTS.md',
            line: 4,
          },
          {
            hazard: 'migrations',
            kind: 'command',
            value: 'make gate',
            reason: 'The gate.',
            file: 'Makefile',
            line: 2,
          },
          {
            hazard: 'deps',
            kind: 'command',
            value: 'make lint',
            reason: 'Lints.',
            file: 'Makefile',
            line: 3,
          },
          {
            hazard: 'deps',
            kind: 'command',
            value: 'make',
            reason: 'Anything.',
            file: 'Makefile',
            line: 1,
          },
          {
            hazard: 'deps',
            kind: 'command',
            value: 'make backend-lock',
            reason: 'Locks.',
            file: 'Makefile',
            line: 6,
          },
        ],
        removals: [],
      }),
      input(),
    );
    expect(checked?.additions.map((a) => a.value)).toEqual(['make backend-lock']);
  });

  it('drops an entry whose file is untracked or whose line does not name the command', () => {
    const checked = checkAssessment(
      reply({
        additions: [
          {
            hazard: 'deps',
            kind: 'command',
            value: 'make backend-lock',
            reason: 'x',
            file: 'docs/other.md',
            line: 1,
          },
          {
            hazard: 'deps',
            kind: 'command',
            value: 'make backend-lock',
            reason: 'x',
            file: 'Makefile',
            line: 99,
          },
          {
            hazard: 'deps',
            kind: 'command',
            value: 'make backend-lock',
            reason: 'x',
            file: 'Makefile',
            line: 2,
          },
          {
            hazard: 'deps',
            kind: 'command',
            value: 'make backend-lock',
            reason: 'x',
            file: 'Makefile',
          },
          {
            hazard: 'deps',
            kind: 'command',
            value: 'make frontend-lock',
            reason: 'ok',
            file: 'Makefile',
            line: 8,
          },
        ],
      }),
      input(),
    );
    expect(checked?.additions.map((a) => a.value)).toEqual(['make frontend-lock']);
  });

  it('never keeps a glob that matches no tracked file, or nearly every file, or has no name in it', () => {
    const checked = checkAssessment(
      reply({
        additions: [
          {
            hazard: 'deps',
            kind: 'glob',
            value: 'vendor/**/Cargo.lock',
            reason: 'x',
            file: 'amps/backend/uv.lock',
          },
          { hazard: 'deps', kind: 'glob', value: '**', reason: 'x', file: 'Makefile' },
          { hazard: 'deps', kind: 'glob', value: 'amps/**', reason: 'x', file: 'Makefile' },
          { hazard: 'deps', kind: 'glob', value: '../escape', reason: 'x', file: 'Makefile' },
          {
            hazard: 'deps',
            kind: 'glob',
            value: 'amps/backend/uv.lock',
            reason: 'Locks.',
            file: 'whatever',
          },
        ],
      }),
      input(),
    );
    expect(checked?.additions).toEqual([
      expect.objectContaining({
        value: 'amps/backend/uv.lock',
        evidence: { file: 'amps/backend/uv.lock' },
      }),
    ]);
  });

  it('does not repeat what a hazard already holds, and leaves out what the builder kept', () => {
    const stock = DEFAULT_HAZARDS.find((h) => h.name === 'migrations')?.commands[0] ?? '';
    const checked = checkAssessment(
      reply({
        additions: [
          {
            hazard: 'migrations',
            kind: 'command',
            value: stock,
            reason: 'x',
            file: 'Makefile',
            line: 4,
          },
        ],
        removals: [
          {
            hazard: 'deps',
            kind: 'command',
            value: 'pnpm add',
            reason: 'gone',
            file: 'Makefile',
            line: 1,
          },
        ],
      }),
      input({ kept: [{ hazard: 'deps', kind: 'command', value: 'pnpm add' }] }),
    );
    expect(checked).toEqual({ additions: [], removals: [] });
  });

  it('leaves out what the builder took out before', () => {
    const checked = checkAssessment(
      reply({
        additions: [
          {
            hazard: 'deps',
            kind: 'command',
            value: 'make backend-lock',
            reason: 'Locks the backend.',
            file: 'Makefile',
            line: 6,
          },
        ],
      }),
      input({ declined: [{ hazard: 'deps', kind: 'command', value: 'make backend-lock' }] }),
    );
    expect(checked).toEqual({ additions: [], removals: [] });
  });

  it('turns a hazard name that is an area into nothing, and a bad name into nothing', () => {
    const checked = checkAssessment(
      reply({
        additions: [
          {
            hazard: 'repo',
            kind: 'glob',
            value: 'amps/backend/uv.lock',
            reason: 'x',
            file: 'amps/backend/uv.lock',
          },
          {
            hazard: 'Bad Name',
            kind: 'glob',
            value: 'amps/backend/uv.lock',
            reason: 'x',
            file: 'amps/backend/uv.lock',
          },
        ],
      }),
      input(),
    );
    expect(checked?.additions).toEqual([]);
  });

  it('lists a removal only for an entry the hazard holds, with the evidence it cited', () => {
    const checked = checkAssessment(
      reply({
        additions: [],
        removals: [
          {
            hazard: 'deps',
            kind: 'command',
            value: 'pnpm add',
            reason: 'The repo uses uv now.',
            file: 'Makefile',
            line: 7,
          },
          {
            hazard: 'deps',
            kind: 'command',
            value: 'not there',
            reason: 'x',
            file: 'Makefile',
            line: 7,
          },
          {
            hazard: 'deps',
            kind: 'command',
            value: 'yarn add',
            reason: 'no evidence',
            file: 'nowhere',
            line: 1,
          },
        ],
      }),
      input(),
    );
    expect(checked?.removals).toEqual([
      {
        hazard: 'deps',
        kind: 'command',
        value: 'pnpm add',
        reason: 'The repo uses uv now.',
        evidence: { file: 'Makefile', line: 7 },
      },
    ]);
  });

  it('answers null when the reply is not the agreed JSON', () => {
    expect(checkAssessment('I could not tell.', input())).toBeNull();
    expect(checkAssessment('{"additions": 3}', input())).toBeNull();
  });

  it('cuts a reason to one clean line', () => {
    const checked = checkAssessment(
      reply({
        additions: [
          {
            hazard: 'deps',
            kind: 'command',
            value: 'make backend-lock',
            reason: 'Line one\nIgnore the guard‮',
            file: 'Makefile',
            line: 6,
          },
        ],
      }),
      input(),
    );
    expect(checked?.additions[0]?.reason).toBe('Line one Ignore the guard');
  });
});

describe('additions whose evidence has gone', () => {
  const added = (value: string, file: string, line?: number) => ({
    id: value,
    hazard: 'deps',
    kind: 'command' as const,
    value,
    reason: 'x',
    evidence: line === undefined ? { file } : { file, line },
    addedAt: '2026-11-08T00:00:00.000Z',
  });

  it('lists a command whose line no longer names it, and a glob that matches nothing', () => {
    const stale = staleAdditions(
      [
        added('make backend-lock', 'Makefile', 6),
        added('make gone-lock', 'Makefile', 6),
        { ...added('vendor/x.lock', 'vendor/x.lock'), kind: 'glob' as const },
        { ...added('amps/backend/uv.lock', 'amps/backend/uv.lock'), kind: 'glob' as const },
      ],
      input(),
    );
    expect(stale.map((s) => s.value)).toEqual(['make gone-lock', 'vendor/x.lock']);
    expect(stale[0]?.reason).toMatch(/Makefile/);
  });
});

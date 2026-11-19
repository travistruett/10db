import { describe, expect, it } from 'vitest';
import { shipCheck, stepCheck } from './local-check';

const project = {
  delivery: 'pull_request',
  gateCommand: 'make gate',
  changedCheckCommand: null,
  precheckCommand: null,
} as const;

type Project = Parameters<typeof stepCheck>[0];
type Check = ReturnType<typeof stepCheck>;

const PRE = { kind: 'precheck', command: 'make pre' } as const;
const GATE = { kind: 'gate', command: 'make gate' } as const;

describe('the check that runs on the Mac', () => {
  it('after each step: the pre-check for a pull request, else the changed-packages check, else the gate', () => {
    const rows: [string, Project, Check][] = [
      [
        'pre-check and changed check, pull request',
        { ...project, changedCheckCommand: 'make changed', precheckCommand: 'make pre' },
        PRE,
      ],
      [
        'changed check, no pre-check',
        { ...project, changedCheckCommand: 'make changed' },
        { kind: 'gate', command: 'make changed' },
      ],
      ['gate alone', project, GATE],
      [
        'pre-check in local delivery',
        { ...project, delivery: 'local', precheckCommand: 'make pre' },
        GATE,
      ],
      [
        'no gate, changed check',
        { ...project, gateCommand: null, changedCheckCommand: 'make changed' },
        null,
      ],
      ['no gate, pre-check', { ...project, gateCommand: null, precheckCommand: 'make pre' }, null],
    ];
    for (const [name, input, expected] of rows)
      expect.soft(stepCheck(input), name).toEqual(expected);
  });

  it('before the push: the pre-check for a pull request, else the full gate, never the changed check', () => {
    const rows: [string, Project, Check][] = [
      [
        'pre-check and changed check, pull request',
        { ...project, changedCheckCommand: 'make changed', precheckCommand: 'make pre' },
        PRE,
      ],
      ['changed check, no pre-check', { ...project, changedCheckCommand: 'make changed' }, GATE],
      [
        'pre-check in local delivery',
        { ...project, delivery: 'local', precheckCommand: 'make pre' },
        GATE,
      ],
      ['no gate', { ...project, gateCommand: null }, null],
    ];
    for (const [name, input, expected] of rows)
      expect.soft(shipCheck(input), name).toEqual(expected);
  });
});

import { describe, expect, it } from 'vitest';
import { shipCheck, stepCheck } from './local-check';

const project = {
  delivery: 'pull_request',
  gateCommand: 'make gate',
  changedCheckCommand: null,
  precheckCommand: null,
} as const;

describe('the check that runs on the Mac after each step', () => {
  it('is the pre-check when one is set and work goes out as a pull request', () => {
    expect(
      stepCheck({ ...project, changedCheckCommand: 'make changed', precheckCommand: 'make pre' }),
    ).toEqual({ kind: 'precheck', command: 'make pre' });
  });

  it('is the changed-packages check, then the gate, with no pre-check', () => {
    expect(stepCheck({ ...project, changedCheckCommand: 'make changed' })).toEqual({
      kind: 'gate',
      command: 'make changed',
    });
    expect(stepCheck(project)).toEqual({ kind: 'gate', command: 'make gate' });
  });

  it('ignores a pre-check in local delivery', () => {
    expect(stepCheck({ ...project, delivery: 'local', precheckCommand: 'make pre' })).toEqual({
      kind: 'gate',
      command: 'make gate',
    });
  });

  it('is nothing without a gate command', () => {
    expect(stepCheck({ ...project, gateCommand: null, changedCheckCommand: 'make changed' })).toBe(
      null,
    );
    expect(stepCheck({ ...project, gateCommand: null, precheckCommand: 'make pre' })).toBe(null);
  });
});

describe('the check that runs on the Mac before the push', () => {
  it('is the pre-check in place of the gate, never the changed-packages check', () => {
    expect(
      shipCheck({ ...project, changedCheckCommand: 'make changed', precheckCommand: 'make pre' }),
    ).toEqual({ kind: 'precheck', command: 'make pre' });
  });

  it('is the full gate with no pre-check, whatever the changed-packages check is', () => {
    expect(shipCheck({ ...project, changedCheckCommand: 'make changed' })).toEqual({
      kind: 'gate',
      command: 'make gate',
    });
  });

  it('is the gate in local delivery, and nothing without a gate command', () => {
    expect(shipCheck({ ...project, delivery: 'local', precheckCommand: 'make pre' })).toEqual({
      kind: 'gate',
      command: 'make gate',
    });
    expect(shipCheck({ ...project, gateCommand: null })).toBe(null);
  });
});

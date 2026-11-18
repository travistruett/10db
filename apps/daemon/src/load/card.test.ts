import { describe, expect, it } from 'vitest';
import { gateNote, overloadStatus } from './card';
import type { Culprit, OverloadReport } from './guard';

const report = (culprits: readonly Culprit[]): OverloadReport => ({
  load: 187.4,
  cores: 10,
  since: new Date('2026-10-30T02:00:00.000Z'),
  culprits,
});

describe('overloadStatus', () => {
  it('says what is held, and that 10db resumes by itself', () => {
    const card = overloadStatus(report([]));
    expect(card.line).toBe('Holding new lanes: the Mac is overloaded (load 187 on 10 cores)');
    expect(card.details).toContain('load average is 187 on 10 cores');
    expect(card.details).toContain('starts no new lane session or gate');
    expect(card.details).toContain('by itself');
  });

  it('names each busy process and the lane or gate it belongs to', () => {
    const card = overloadStatus(
      report([
        {
          pid: 4242,
          cpu: 99.5,
          command: 'sh loop.sh',
          owner: { kind: 'lane', workstreamId: 'ws_1', label: 'task "Fix login"' },
        },
        {
          pid: 4300,
          cpu: 80,
          command: 'vitest run',
          owner: { kind: 'gate', label: 'the shipping gate of batch "Greetings"' },
        },
      ]),
    );
    expect(card.details).toContain(
      'pid 4242 (sh loop.sh) at 100% of a core: the lane for task "Fix login"',
    );
    expect(card.details).toContain(
      'pid 4300 (vitest run) at 80% of a core: the shipping gate of batch "Greetings"',
    );
  });

  it('says a process that is not 10db’s is not', () => {
    const card = overloadStatus(
      report([{ pid: 9, cpu: 300, command: 'ffmpeg', owner: { kind: 'other' } }]),
    );
    expect(card.details).toContain('pid 9 (ffmpeg) at 300% of a core: not 10db’s');
    expect(card.details).toContain('Nothing here is 10db’s');
  });

  it.each([
    [
      'Spotlight',
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds_stores',
    ],
    [
      'Spotlight',
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared',
    ],
    [
      'the file-change watcher',
      '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/FSEvents.framework/Versions/A/Support/fseventsd',
    ],
  ])('points a busy %s at what 10db can keep it off', (_name, command) => {
    const card = overloadStatus(report([{ pid: 5, cpu: 98, command, owner: { kind: 'other' } }]));
    expect(card.details).toContain('Keep Spotlight Out');
    expect(card.details).toContain('Remove Merged Worktrees');
  });

  it('does not mention Spotlight when it is not busy', () => {
    const card = overloadStatus(
      report([{ pid: 9, cpu: 300, command: 'ffmpeg', owner: { kind: 'other' } }]),
    );
    expect(card.details).not.toContain('Spotlight');
  });

  it('says a process left by an ended lane is 10db’s, and how to stop it', () => {
    const card = overloadStatus(
      report([{ pid: 11, cpu: 99, command: 'sh loop.sh', owner: { kind: 'ended-lane' } }]),
    );
    expect(card.details).toContain('left behind by a lane session that has ended');
    expect(card.details).toContain('kill 11');
  });

  it('says the daemon itself is 10db’s', () => {
    const card = overloadStatus(
      report([{ pid: 100, cpu: 90, command: 'git gc', owner: { kind: 'daemon' } }]),
    );
    expect(card.details).toContain('10db itself, not a lane or a gate');
  });

  it('says so when it could not read what is busy', () => {
    expect(overloadStatus(report([])).details).toContain('could not read which processes');
  });
});

describe('gateNote', () => {
  it('says the Mac was overloaded and what that does to a gate', () => {
    const note = gateNote({ peakLoad: 187.4, cores: 10 });
    expect(note).toContain('overloaded');
    expect(note).toContain('load average reached 187 on 10 cores');
    expect(note).toContain('timeouts');
  });
});

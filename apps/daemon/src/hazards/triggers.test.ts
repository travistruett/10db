import { EventType, type DaemonEvent, type ProjectId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { createEventBus } from '../events';
import { changesWhatHazardsReadFrom, subscribeHazardAssessment } from './triggers';

describe('which changed files make a project worth reading again', () => {
  it.each([
    'package.json',
    'amps/frontend/package.json',
    'pnpm-lock.yaml',
    'amps/backend/uv.lock',
    'Cargo.lock',
    'Makefile',
    'amps/Makefile',
    'tools/build.mk',
    'docker-compose.yml',
    'deploy/compose.prod.yaml',
    'AGENTS.md',
    'amps/AGENTS.md',
    'go.mod',
  ])('%s', (path) => {
    expect(changesWhatHazardsReadFrom([path])).toBe(true);
  });

  it.each(['src/main.ts', 'README.md', 'docs/agents.md', 'package.json.bak', 'src/Makefile.ts'])(
    '%s is not one',
    (path) => {
      expect(changesWhatHazardsReadFrom([path])).toBe(false);
    },
  );
});

const event = (type: EventType, entityId: string, data: DaemonEvent['data'] = {}): DaemonEvent => ({
  seq: 1,
  type,
  entityType: 'x',
  entityId,
  data,
  at: '2026-11-08T00:00:00.000Z',
});

describe('the background reading', () => {
  function setup() {
    const bus = createEventBus();
    const scheduled: string[] = [];
    const stop = subscribeHazardAssessment(
      bus,
      { projectOfWorkstream: (id) => (id === 'ws-1' ? ('p-1' as ProjectId) : null) },
      { schedule: (id) => scheduled.push(id) },
    );
    return { bus, scheduled, stop };
  }

  it('reads a new project', () => {
    const { bus, scheduled } = setup();
    bus.publish([event(EventType.ProjectCreated, 'p-9')]);
    expect(scheduled).toEqual(['p-9']);
  });

  it('reads a project again when a commit changes a manifest or a lockfile', () => {
    const { bus, scheduled } = setup();
    bus.publish([
      event(EventType.CommitRecorded, 'ws-1', { paths: ['src/a.ts', 'pnpm-lock.yaml'] }),
    ]);
    expect(scheduled).toEqual(['p-1']);
  });

  it('ignores a commit of other files, an unknown workstream and a stopped listener', () => {
    const { bus, scheduled, stop } = setup();
    bus.publish([event(EventType.CommitRecorded, 'ws-1', { paths: ['src/a.ts'] })]);
    bus.publish([event(EventType.CommitRecorded, 'ws-2', { paths: ['Makefile'] })]);
    bus.publish([event(EventType.CommitRecorded, 'ws-1', {})]);
    stop();
    bus.publish([event(EventType.ProjectCreated, 'p-9')]);
    expect(scheduled).toEqual([]);
  });
});

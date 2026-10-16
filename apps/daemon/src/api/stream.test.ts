import type { DaemonEvent } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import type { ApiServices } from './services';
import { streamEvents } from './stream';

const ev = (seq: number): DaemonEvent => ({
  seq,
  type: 'task.created',
  entityType: 'task',
  entityId: 'x',
  data: {},
  at: '2026-10-13T12:00:00.000Z',
});

type Services = Pick<ApiServices, 'eventsAfter' | 'subscribe'>;

describe('streamEvents', () => {
  it('replays after the cursor, then streams live, with no gap or duplicate at the seam', () => {
    const history = [ev(1), ev(2), ev(3)];
    // Cast rather than annotate: an annotated `let x: F | null = null` narrows to `null`, because the only
    // other assignments happen inside callbacks, and then `listener?.(…)` fails to typecheck.
    let listener = null as ((e: DaemonEvent) => void) | null;
    const services: Services = {
      subscribe: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
      eventsAfter: (after) => {
        // Event 4 commits while the replay query runs: it must arrive once, after 3.
        if (after === 1) {
          history.push(ev(4));
          listener?.(ev(4));
        }
        return history.filter((e) => e.seq > after);
      },
    };
    const sent: number[] = [];
    const stop = streamEvents(1, services, (e) => sent.push(e.seq));
    listener?.(ev(4));
    listener?.(ev(5));
    stop();
    listener?.(ev(6));
    expect(sent).toEqual([2, 3, 4, 5]);
  });

  it('delivers in seq order when a listener publishes a later event before an earlier one', () => {
    const history = [ev(1)];
    let listener = null as ((e: DaemonEvent) => void) | null;
    const services: Services = {
      subscribe: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
      eventsAfter: (after) => history.filter((e) => e.seq > after),
    };
    const sent: number[] = [];
    streamEvents(0, services, (e) => sent.push(e.seq));
    // Events 2 and 3 are committed, but a re-entrant write makes 3 reach this listener first.
    history.push(ev(2), ev(3));
    listener?.(ev(3));
    listener?.(ev(2));
    expect(sent).toEqual([1, 2, 3]);
  });

  it('orders events that were buffered during the replay', () => {
    const history = [ev(1)];
    let listener = null as ((e: DaemonEvent) => void) | null;
    const services: Services = {
      subscribe: (fn) => {
        listener = fn;
        return () => undefined;
      },
      eventsAfter: (after) => {
        if (after === 0) {
          history.push(ev(2), ev(3));
          listener?.(ev(3));
          listener?.(ev(2));
        }
        return history.filter((e) => e.seq > after && e.seq <= 1);
      },
    };
    const sent: number[] = [];
    streamEvents(0, services, (e) => sent.push(e.seq));
    expect(sent).toEqual([1, 2, 3]);
  });

  it('pages through a long replay', () => {
    const history = Array.from({ length: 1200 }, (_, i) => ev(i + 1));
    const services: Services = {
      subscribe: () => () => undefined,
      eventsAfter: (after, limit) => history.filter((e) => e.seq > after).slice(0, limit),
    };
    const sent: number[] = [];
    streamEvents(0, services, (e) => sent.push(e.seq));
    expect(sent).toHaveLength(1200);
  });
});

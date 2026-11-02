import { GoalDigestDto, GoalListDto, GoalStatus, NotFoundError, mintId } from '@10db/contracts';
import { insertDecision, insertGoal, insertSource, lastGoalView } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createServices } from './services';

let h: DeliveryHarness;
beforeEach(() => {
  h = createDeliveryHarness({}, { trigger: false });
});
afterEach(() => {
  h.close();
});

/** Only the goal services run here, and they read the state store, so that is the real one. */
function goalServices() {
  // A cast at a test boundary: the goal services touch nothing else of the deps.
  return createServices({ state: h.state } as unknown as Parameters<typeof createServices>[0]);
}

function goal() {
  return h.state.write((ctx) =>
    insertGoal(ctx, h.project.id, {
      brief: {
        title: 'Real areas',
        objective: 'Areas.',
        tasks: [
          { key: 'a', title: 'Patch route', areas: h.project.areas.slice(0, 1).map((a) => a.name) },
        ],
      },
    }),
  );
}

function decide(question: string) {
  h.state.write((ctx) =>
    insertDecision(ctx, {
      projectId: h.project.id,
      question,
      choice: 'Packages',
      rationale: 'why',
      decidedBy: 'you',
      scope: 'project',
      area: null,
      sourceId: insertSource(ctx, 'agent', {}),
    }),
  );
}

describe('the goal services', () => {
  it('answers a digest that parses and marks the goal viewed, so the next one starts there', () => {
    const { id } = goal();
    decide('Areas follow packages?');
    const services = goalServices();

    const first = GoalDigestDto.parse(services.openGoalDigest(id));
    expect(first).toMatchObject({ status: GoalStatus.NotStarted, since: null });
    expect(first.decisions.recent).toHaveLength(1);
    const builder = h.state.db.$client
      .prepare('select id from people where is_builder = 1')
      .get() as { id: never };
    const mark = lastGoalView(h.state.db, id, builder.id);
    expect(mark).not.toBeNull();

    const second = services.openGoalDigest(id);
    expect(second.since).toBe(mark);
    expect(second.decisions.recent).toEqual([]);
    expect(second.decisions.earlier).toHaveLength(1);
  });

  it('refuses a goal that does not exist', () => {
    expect(() => goalServices().openGoalDigest(mintId('Goal'))).toThrow(NotFoundError);
  });

  it('lists the project’s goals without marking any of them viewed', () => {
    const { id } = goal();
    decide('Areas follow packages?');
    const list = GoalListDto.parse(goalServices().listGoals(h.project.id));
    expect(list.goals).toHaveLength(1);
    expect(list.goals[0]).toMatchObject({ newItems: 1 });
    expect(goalServices().openGoalDigest(id).since).toBeNull();
  });
});

import { insertBuilderMessage, taskConversationOf } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import type { LaneSessionSpec } from '../sessions';

// Sessions spec §9.1: a lane session names its task's conversation once the task has a thread, so
// the session row and the spec the adapter opens agree on it.

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

function recordSpecs(): LaneSessionSpec[] {
  const specs: LaneSessionSpec[] = [];
  engine.adapter.seen = (spec) => {
    specs.push(spec);
    return {};
  };
  return specs;
}

describe('a lane session’s conversation', () => {
  it.each([{ name: 'is its task’s thread when the builder wrote before the run', writes: true }])(
    '$name',
    async ({ writes }) => {
      engine = await createTestEngine({ Alpha: [[{ do: 'turn_complete' }]] });
      const specs = recordSpecs();
      const { task, workstream } = engine.addTask('Alpha');
      if (writes)
        engine.state.write((ctx) =>
          insertBuilderMessage(ctx, task.id, { body: 'Start with the header', files: [] }),
        );
      engine.launch(workstream.id);
      await engine.runner.idle();
      const thread = taskConversationOf(engine.state.db, task.id);
      expect(thread === null).toBe(!writes);
      expect(specs.map((s) => s.conversationId)).toEqual([thread?.id ?? null]);
    },
  );
});

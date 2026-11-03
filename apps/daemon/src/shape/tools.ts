import {
  InvalidError,
  ShapeMessageAuthor,
  ShapeMessageKind,
  type PlanDraft,
  type ShapeId,
} from '@10db/contracts';
import { getShape, insertShapeMessage } from '@10db/db';
import type { StateStore } from '../events';
import type { ShapeToolHandlers } from '../mcp';
import { reconcileDraft } from './rounds';

// Shape spec §5.5. The tools a conversation's session calls through the `10db` MCP server. This
// slice serves note_heard and propose_plan; the others come with the slices that use them.

export interface ShapeToolDeps {
  readonly state: StateStore;
  /** Told after each propose_plan call whether it was accepted, for the turn's guard (§5.3). */
  onProposal?(shapeId: ShapeId, accepted: boolean): void;
}

const plural = (n: number, noun: string): string => `${String(n)} ${noun}`;

/** The draft's size in the words the transcript's dimmed line uses: "1 goal, 3 loose". */
function describeDraft(draft: PlanDraft): string {
  const parts = [
    draft.goals.length > 0
      ? plural(draft.goals.length, draft.goals.length === 1 ? 'goal' : 'goals')
      : '',
    draft.looseTasks.length > 0 ? plural(draft.looseTasks.length, 'loose') : '',
    draft.records.length > 0
      ? plural(draft.records.length, draft.records.length === 1 ? 'record' : 'records')
      : '',
    draft.additions.length + draft.changes.length + draft.removals.length > 0
      ? plural(
          draft.additions.length + draft.changes.length + draft.removals.length,
          'change to what was converted',
        )
      : '',
  ].filter((p) => p !== '');
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

const BEFORE_PROPOSE =
  'propose_plan is refused until the builder presses Propose. Keep listening: answer from the code, ask questions, and echo what you have heard with note_heard.';

export function createShapeToolHandlers(deps: ShapeToolDeps, shapeId: ShapeId): ShapeToolHandlers {
  const line = (body: string): void => {
    deps.state.write((ctx) => {
      insertShapeMessage(ctx, shapeId, {
        author: ShapeMessageAuthor.Claude,
        kind: ShapeMessageKind.Tool,
        body,
      });
    });
  };
  return {
    note_heard: (input) => {
      line(`note_heard · ${input.items.join(' · ')}`);
      return Promise.resolve({ heard: input.items.length });
    },
    propose_plan: (input) => {
      if (!getShape(deps.state.db, shapeId).proposeUnlocked) {
        line('propose_plan · refused');
        deps.onProposal?.(shapeId, false);
        return Promise.reject(new InvalidError(BEFORE_PROPOSE));
      }
      // The reconcile and its transcript line are one write: the line never disagrees with the rows.
      const outcome = deps.state.write((ctx) => {
        const result = reconcileDraft(ctx, shapeId, input.draft);
        insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Claude,
          kind: ShapeMessageKind.Tool,
          body: result.ok
            ? `propose_plan · ${describeDraft(input.draft)} · passed`
            : `propose_plan · refused · ${plural(result.errors.length, result.errors.length === 1 ? 'error' : 'errors')}`,
        });
        return result;
      });
      deps.onProposal?.(shapeId, outcome.ok);
      if (!outcome.ok)
        return Promise.reject(
          new InvalidError(
            `${plural(outcome.errors.length, outcome.errors.length === 1 ? 'error' : 'errors')}; nothing was changed. Fix them all and call propose_plan again:\n${outcome.errors.map((e) => `- ${e}`).join('\n')}`,
          ),
        );
      return Promise.resolve({
        round: outcome.round,
        created: outcome.created,
        updated: outcome.updated,
        superseded: outcome.superseded,
        kept: outcome.kept,
        converted: outcome.converted,
      });
    },
  };
}

import { McpToolName, StepRole, Verdict, type Rigor } from '@10db/contracts';
import type { z } from 'zod';
import { DEFAULT_ROWS } from '../../src/routing';
import type { FakeScriptBook } from '../../src/sessions';

type Book = z.input<typeof FakeScriptBook>;
type Session = Book[string][number];

/** What the fake agent needs of a case: the task it plays, and the one file its build writes. */
export interface FakeCase {
  readonly id: string;
  readonly title: string;
  /** A repo-relative path inside the case's areas; the build writes it and commits it. */
  readonly editPath: string;
}

const done = { do: 'turn_complete' } as const;

/** One session per step the rigor runs on a fresh data dir, in the order the steps run. */
function sessionFor(role: StepRole, c: FakeCase, index: number): Session {
  const opId = (what: string) => `eval-${what}-${String(index)}-${c.id}`.slice(0, 100);
  switch (role) {
    case StepRole.Implement:
      return [
        {
          do: 'tool',
          toolName: 'Write',
          input: { file_path: c.editPath, content: `Fake build of ${c.id}.\n` },
        },
        {
          do: 'mcp',
          tool: McpToolName.Commit,
          args: { opId: opId('commit'), paths: [c.editPath], message: `Fake build of ${c.id}` },
        },
        done,
      ];
    case StepRole.Plan:
      return [
        {
          do: 'mcp',
          tool: McpToolName.CompleteStep,
          args: { opId: opId('plan'), summary: `Fake plan for ${c.id}: write ${c.editPath}.` },
        },
        done,
      ];
    case StepRole.PlanReview:
    case StepRole.Review:
    case StepRole.Qa:
      return [
        {
          do: 'mcp',
          tool: McpToolName.CompleteStep,
          args: {
            opId: opId(role),
            summary: 'The fake build is as planned.',
            verdict: Verdict.Approve,
          },
        },
        done,
      ];
  }
}

/**
 * The fake agent's script for every case at `rigor`: each step writes, commits or approves at once,
 * so a run goes through the whole pipeline (lanes, MCP tools, gate, review, the report) without a model.
 */
export function fakeBookFor(cases: readonly FakeCase[], rigor: Rigor): Book {
  const roles = DEFAULT_ROWS[rigor];
  return Object.fromEntries(
    cases.map((c) => [c.title, roles.map((role, index) => sessionFor(role, c, index))]),
  );
}

import { describe, expect, it, vi } from 'vitest';
import type { GuardVerdict } from '../guard';
import { judgedVerdict } from './session-judge';
import type { JudgedCallRequest, ShapeVerdict } from './types';

const req: JudgedCallRequest = {
  toolName: 'Bash',
  input: { command: 'vercel deploy --prod' },
  cwd: '/w',
  toolUseId: 't1',
  signal: new AbortController().signal,
  hunk: null,
};
const settledByJudge: GuardVerdict = { decision: 'allow', settled: 'The builder allowed this.' };

describe('judgedVerdict', () => {
  it.each<[string, ShapeVerdict]>([
    ['an ask', { decision: 'ask', reason: 'the guard asks' }],
    ['a deny', { decision: 'deny', reason: 'the guard refuses' }],
    ['a settled allow', { decision: 'allow', settled: 'already settled' }],
    ['a rewriting allow', { decision: 'allow', updatedInput: { command: 'ls' } }],
  ])(
    "keeps the guard's %s, so a judge's settled allow (a grant) never overrides it",
    async (_name, verdict) => {
      const judgeCall = vi.fn(() => Promise.resolve(settledByJudge));
      expect(await judgedVerdict({ judgeCall }, verdict, req)).toEqual(verdict);
      expect(judgeCall).not.toHaveBeenCalled();
    },
  );

  it("gives a bare allow to the session's judge", async () => {
    const judgeCall = vi.fn(() => Promise.resolve(settledByJudge));
    expect(await judgedVerdict({ judgeCall }, { decision: 'allow' }, req)).toEqual(settledByJudge);
    expect(judgeCall).toHaveBeenCalledOnce();
  });
});

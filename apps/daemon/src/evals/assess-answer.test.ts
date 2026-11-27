import { describe, expect, it } from 'vitest';
import { EvalLiveModels, EvalModelChoice, EvalModelId } from '@10db/contracts';
import { parseAssessAnswer } from './assess-answer';

const MANIFEST = {
  suites: [
    {
      key: 'chat.answer',
      label: 'Chat answer',
      definitionPaths: ['evals/chat/answer.py'],
      coveredPaths: ['app/chat/**'],
      bar: 'Answers cite their sources.',
      freeCommand: 'make test',
      liveCommand: 'make eval TASK=chat.answer',
    },
  ],
  gaps: [{ label: 'Summary call', where: 'app/summary.py:41', why: 'Nothing grades its output.' }],
};

describe('parseAssessAnswer', () => {
  it('reads a bare, a fenced and a sentence-wrapped answer as the same manifest', () => {
    const json = JSON.stringify(MANIFEST);
    for (const reply of [
      json,
      `\`\`\`json\n${json}\n\`\`\``,
      `Here is what I found.\n${json}\nLet me know if you want more.`,
    ]) {
      const answer = parseAssessAnswer(reply);
      expect(answer.ok && answer.manifest.suites.map((s) => s.key)).toEqual(['chat.answer']);
      expect(answer.ok && answer.manifest.callPatterns).toEqual([]);
    }
  });

  it('records nothing for prose, a refused field or an answer with no suite and no gap', () => {
    const refused = [
      'I could not find any evals in this repository.',
      JSON.stringify({ suites: [{ key: 'a b', definitionPaths: [] }], gaps: [] }),
      JSON.stringify({ ...MANIFEST, invented: true }),
      JSON.stringify({ suites: [], gaps: [] }),
    ];
    for (const reply of refused) expect(parseAssessAnswer(reply).ok).toBe(false);
  });

  it('keeps a suite whose model env is refused and drops only that env', () => {
    const live = { docker: true, models: { env: 'PATH', ids: 'openrouter' } };
    const suites = [
      { ...MANIFEST.suites[0], live },
      {
        ...MANIFEST.suites[0],
        key: 'b',
        live: { ...live, models: { env: 'MODELS', ids: 'openrouter' } },
      },
    ];
    const answer = parseAssessAnswer(JSON.stringify({ ...MANIFEST, suites }));
    expect(answer.ok && answer.manifest.suites.map((s) => s.live?.models?.env)).toEqual([
      undefined,
      'MODELS',
    ]);
  });
});

describe('what a model env value may be', () => {
  it('passes only strict ids, plain names and unreserved env names', () => {
    for (const id of ['google/gemini-3.8-flash', '@preset/amps-speed', 'openai/gpt-6-luna:free']) {
      expect(EvalModelId.safeParse(id).success).toBe(true);
    }
    for (const id of ['a b', 'x;rm -rf ~', '$(id)', '`id`', 'a,b']) {
      expect(EvalModelId.safeParse(id).success).toBe(false);
    }
    for (const env of ['PATH', 'DYLD_INSERT_LIBRARIES', 'GIT_DIR', 'MAKEFLAGS', 'lowercase']) {
      expect(EvalLiveModels.safeParse({ env, ids: 'openrouter' }).success).toBe(false);
    }
    expect(EvalLiveModels.safeParse({ env: 'MODELS', ids: 'openrouter' }).success).toBe(true);
    expect(EvalModelChoice.safeParse({ name: '-rf', model: 'a/b' }).success).toBe(false);
  });
});

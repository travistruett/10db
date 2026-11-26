import { describe, expect, it } from 'vitest';
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
});

// Spike 5: AskUserQuestion and ordinary permission prompts both arrive at canUseTool with structured data; an
// answer returned through updatedInput.answers reaches the model; a deny is honored and the agent continues.
// The probe picks the answer at random, so the model can't pass by choosing on its own. A second run records the
// multi-select, free-text ("Other") and annotations.notes formats the inbox needs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { makeFixtureRepo } from './fixture-repo.ts';
import { check, finish, info, partial } from './report.ts';
import { baseOptions, resultText, runOnce } from './session.ts';

type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean };
const calls: { tool: string; keys: string[]; suggestions: unknown; blockedPath?: string }[] = [];
let asked: Question | undefined;
const wanted = Math.random() < 0.5 ? 'alpha' : 'beta';
const other = wanted === 'alpha' ? 'beta' : 'alpha';
info('answer chosen by the probe', wanted);

const canUseTool: CanUseTool = async (toolName, input, options) => {
  calls.push({ tool: toolName, keys: Object.keys(input), suggestions: options.suggestions ?? null, ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}) });
  if (toolName === 'AskUserQuestion') {
    const questions = input['questions'] as Question[];
    asked = questions[0];
    const pick = asked?.options.find((o) => new RegExp(wanted, 'i').test(o.label));
    return { behavior: 'allow', updatedInput: { ...input, answers: { [asked?.question ?? '']: pick?.label ?? wanted } } };
  }
  if (toolName === 'Bash') return { behavior: 'deny', message: 'Denied by the 10db spike. Continue without running it.' };
  return { behavior: 'allow', updatedInput: input };
};

const repo = makeFixtureRepo();
const main = await runOnce(
  'Step 1: use the AskUserQuestion tool to ask me ONE question with exactly two options: name the new file ' +
    'alpha.txt or beta.txt. Step 2: create the file I chose, containing the word chosen, with the Write tool. ' +
    'Step 3: run `touch gamma.txt` with the Bash tool. If that is denied, do not retry it and do not create ' +
    'gamma.txt any other way. Step 4: reply DONE.',
  baseOptions(repo, { canUseTool, permissionMode: 'default', maxTurns: 10 }),
);

info('canUseTool calls', calls.map((c) => ({ tool: c.tool, keys: c.keys, blockedPath: c.blockedPath })));
info('Write suggestions', calls.find((c) => c.tool === 'Write')?.suggestions ?? null);
info('Bash suggestions', calls.find((c) => c.tool === 'Bash')?.suggestions ?? null);
info('question as received', asked ?? null);
check('AskUserQuestion reached canUseTool', calls.some((c) => c.tool === 'AskUserQuestion'), calls.map((c) => c.tool).join(','));
check('question is structured with ≥2 options', (asked?.options.length ?? 0) >= 2 && typeof asked?.header === 'string', JSON.stringify(asked?.options.map((o) => o.label) ?? []));
check(`answer delivered: ${wanted}.txt created, ${other}.txt absent`, existsSync(join(repo, `${wanted}.txt`)) && !existsSync(join(repo, `${other}.txt`)), `${wanted}.txt exists`);
check('Write permission reached canUseTool', calls.some((c) => c.tool === 'Write'), 'Write seen');
check('Bash permission reached canUseTool', calls.some((c) => c.tool === 'Bash'), 'Bash seen');
check('deny honored: gamma.txt absent', !existsSync(join(repo, 'gamma.txt')), 'the denied command left no file');
check('agent continued after the deny', main.result?.subtype === 'success' && /DONE/.test(resultText(main)), `${main.result?.subtype ?? 'no result'}: ${resultText(main).slice(0, 40)}`);

// Answer formats: multi-select joined with ", ", a free-text "Other" answer, and annotations.notes.
const formats: Record<string, unknown>[] = [];
const formatsTool: CanUseTool = async (toolName, input) => {
  if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
  const questions = input['questions'] as Question[];
  formats.push({ received: questions.map((q) => ({ question: q.question, multiSelect: q.multiSelect, labels: q.options.map((o) => o.label) })) });
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes: string }> = {};
  for (const q of questions) {
    answers[q.question] = q.multiSelect ? q.options.slice(0, 2).map((o) => o.label).join(', ') : 'TEAL-FREETEXT';
    annotations[q.question] = { notes: 'NOTE-CANARY-OCELOT' };
  }
  return { behavior: 'allow', updatedInput: { ...input, answers, annotations } };
};
const fmt = await runOnce(
  'Use the AskUserQuestion tool once with TWO questions: (1) a multiSelect question "Which fruits?" with options ' +
    'Apple, Banana, Cherry; (2) a single-select question "Which color?" with options Red, Blue. Then reply with ' +
    'three lines: the fruits I chose, the color I chose, and any note I attached (or NONE).',
  baseOptions(makeFixtureRepo(), { canUseTool: formatsTool, permissionMode: 'default', maxTurns: 4 }),
);
const reply = resultText(fmt);
info('answer formats', { formats, reply });
const fruits = /apple/i.test(reply) && /banana/i.test(reply);
const freeText = /TEAL-FREETEXT/.test(reply);
const notes = /OCELOT/.test(reply);
if (fruits) check('multi-select: ", "-joined labels reach the model', true, reply.split('\n')[0] ?? '');
else partial('multi-select: ", "-joined labels reach the model', reply.slice(0, 120));
if (freeText) check('free-text "Other" answer reaches the model', true, 'TEAL-FREETEXT echoed');
else partial('free-text "Other" answer reaches the model', reply.slice(0, 120));
if (notes) check('annotations.notes reach the model', true, 'note echoed');
else partial('annotations.notes reach the model', 'not echoed; M1a appends notes to the answer string instead');
info('file contents', existsSync(join(repo, `${wanted}.txt`)) ? readFileSync(join(repo, `${wanted}.txt`), 'utf8').trim() : null);
finish();

import { CHOICE_SYSTEM, readChoiceAnswer, type MessagesQuestion } from './anthropic';
import { JudgeCallError } from './credential';
import {
  NOULS_SYSTEM,
  noulsPrompt,
  readReportedProbabilities,
  type NoulAnswers,
  type NoulsAsked,
} from './noul-questions';
import { optionsText, type ModelAnswer } from './openrouter';

type ChoiceAsked = Pick<MessagesQuestion, 'state' | 'question' | 'options' | 'criteria'>;

/**
 * A choice asked in a one-shot session on a project's own account. A session takes one prompt and no output schema,
 * so the system text leads the prompt and the reply's JSON is found in whatever prose comes with it.
 */
export function sessionChoicePrompt(q: ChoiceAsked): string {
  return [
    CHOICE_SYSTEM,
    '',
    `Content:\n${q.state}`,
    '',
    `Question: ${q.question}\nOptions: ${optionsText(q)}`,
    '',
    'Reply with only a JSON object {"choice": "<one option>", "confidence": <a number from 0 to 1>}.',
  ].join('\n');
}

/** Yes/no questions asked in a one-shot session, answered as one number per question id. */
export function sessionNoulsPrompt(q: Pick<NoulsAsked, 'state' | 'questions'>): string {
  const shape = Object.keys(q.questions)
    .map((id) => `"${id}": <probability of yes, a number from 0 to 1>`)
    .join(', ');
  return [NOULS_SYSTEM, '', noulsPrompt(q), '', `Reply with only a JSON object {${shape}}.`].join(
    '\n',
  );
}

const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)```/;

/** The JSON a reply carries: a fenced block's body when there is one, else the text from its first `{` to its last `}`. */
function jsonOf(text: string): string {
  const fenced = FENCED_JSON.exec(text)?.[1];
  if (fenced !== undefined) return fenced.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start === -1 || end < start ? text : text.slice(start, end + 1);
}

/** A session's reply as an answer to a choice. Throws JudgeCallError when it is not one of the options as JSON. */
export function parseSessionChoice(
  q: Pick<MessagesQuestion, 'options'>,
  text: string,
  model: string,
): ModelAnswer {
  return { ...readChoiceAnswer(q, jsonOf(text)), model, costUsd: null };
}

/**
 * A session's reply as answers to yes/no questions. Throws JudgeCallError when any question is left out or its value
 * is not a number from 0 to 1: a low probability lets a call run, so nothing is ever read as one by default.
 */
export function parseSessionNouls(
  q: Pick<NoulsAsked, 'questions'>,
  text: string,
  model: string,
): NoulAnswers {
  const probabilities = readReportedProbabilities(q, jsonOf(text));
  if (probabilities === null)
    throw new JudgeCallError('The model did not answer every question with a number');
  return { probabilities, model, costUsd: null };
}

import { EvalCheckKind, EvalSuggestedCase, type EvalSuggestResult } from '@10db/contracts';
import { z } from 'zod';
import { modelJson } from '../folders';

/** The questions the wizard asks, one per step that offers a suggestion. */
export type SuggestKind = 'tighten' | 'cases' | 'check';

/** What the answer made of: the usable part, or why nothing is shown. */
export type SuggestAnswer =
  | { readonly ok: true; readonly answer: Extract<EvalSuggestResult, { ok: true }>['answer'] }
  | { readonly ok: false; readonly reason: string };

const Tighten = z.object({ behavior: z.string().trim().min(1).max(600) });
const Cases = z.object({ cases: z.array(EvalSuggestedCase).min(1).max(10) });
const Check = z.object({ check: z.enum(EvalCheckKind), rule: z.string().trim().max(400) });

const UNUSABLE = "The model's answer could not be used, so nothing changed.";

/**
 * Reads a model's reply to one wizard question: the JSON from the first `{` to the last `}`, checked against
 * the shape that question asks for. A reply with no JSON, a missing or oversized field, or no case at all
 * shows nothing.
 */
export function parseSuggestAnswer(kind: SuggestKind, reply: string): SuggestAnswer {
  const json = modelJson(reply);
  switch (kind) {
    case 'tighten': {
      const parsed = Tighten.safeParse(json);
      return parsed.success
        ? { ok: true, answer: { kind, behavior: parsed.data.behavior } }
        : { ok: false, reason: UNUSABLE };
    }
    case 'cases': {
      const parsed = Cases.safeParse(json);
      return parsed.success
        ? { ok: true, answer: { kind, cases: parsed.data.cases } }
        : { ok: false, reason: UNUSABLE };
    }
    case 'check': {
      const parsed = Check.safeParse(json);
      return parsed.success
        ? { ok: true, answer: { kind, check: parsed.data.check, rule: parsed.data.rule } }
        : { ok: false, reason: UNUSABLE };
    }
  }
}

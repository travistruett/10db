import { z } from 'zod';
import { StepRole } from './states';
import type { StepResult, WorkstreamStep } from './steps';

/** Times the work may be sent back, by a reviewer, a gate or the builder, before the workstream fails. */
export const FIX_ATTEMPT_LIMIT = 3;

/** The longest headline a finding keeps; the full review has the rest. */
const HEADLINE_CHARS = 240;

export const Finding = z.object({
  /** The severity word the reviewer wrote, such as BLOCKING; null when it wrote none. */
  severity: z.string().nullable(),
  /** `file:line` (or `file:from-to`) as the reviewer wrote it; null when it named none. */
  location: z.string().nullable(),
  text: z.string(),
});
export type Finding = z.infer<typeof Finding>;

const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const SEVERITY_WORD =
  /\b(BLOCKING|BLOCKER|CRITICAL|MAJOR|MINOR|NIT|NOTE|WARNING|INFO|HIGH|MEDIUM|LOW)\b/;
const SEVERITY_TAG =
  /[[(]\s*(blocking|blocker|critical|major|minor|nit|note|warning|info|high|medium|low)\s*[\])]/i;
// A path with an extension, then a line or a line range; `host:8080` has no extension to match.
const LOCATION =
  /(?<![\w/.@-])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]*):(\d+)(?:[-–](\d+))?/;

/** The token a finding's severity was read from: a bracketed tag first, else a capitalised word. */
const severityMatch = (headline: string): RegExpExecArray | null =>
  SEVERITY_TAG.exec(headline) ?? SEVERITY_WORD.exec(headline);

function severityOf(headline: string): string | null {
  return severityMatch(headline)?.[1]?.toUpperCase() ?? null;
}

function locationOf(text: string): string | null {
  const match = LOCATION.exec(text);
  if (!match) return null;
  const [, file, from, to] = match;
  return to ? `${file ?? ''}:${from ?? ''}-${to}` : `${file ?? ''}:${from ?? ''}`;
}

function findingOf(lines: readonly string[]): Finding {
  const headline = (lines[0] ?? '').trim();
  const text =
    headline.length > HEADLINE_CHARS ? `${headline.slice(0, HEADLINE_CHARS - 1)}…` : headline;
  return { severity: severityOf(headline), location: locationOf(lines.join('\n')), text };
}

/**
 * The findings in a review's notes. The reviewer persona writes each finding as a numbered note
 * (`1. BLOCKING path:line ...`); a finding's severity and location are what it wrote. Notes with no
 * numbering are one finding; text before the first number is not a finding.
 */
export function parseFindings(summary: string): Finding[] {
  const items: string[][] = [];
  for (const line of summary.split('\n')) {
    const start = NUMBERED.exec(line);
    if (start) items.push([start[1] ?? '']);
    else items.at(-1)?.push(line);
  }
  if (items.length === 0) {
    const lines = summary.split('\n').filter((l) => l.trim() !== '');
    return lines.length === 0 ? [] : [findingOf(lines)];
  }
  return items.map(findingOf);
}

/**
 * A finding's sentence without the severity and location a view shows apart. The whole headline
 * when nothing would be left.
 */
export function findingBody(finding: Finding): string {
  let text = finding.text;
  // The same token the severity was read from, so a word that only contains it stays whole.
  const severity = finding.severity ? severityMatch(text) : null;
  if (severity)
    text = text.slice(0, severity.index) + text.slice(severity.index + severity[0].length);
  if (finding.location) text = text.replace(finding.location, '');
  const body = text.replace(/^[\s:,\-–—`'"()[\]]+/, '').trim();
  return body === '' ? finding.text : body;
}

/** One verdict a review, plan review or QA step gave, with the step that gave it. */
export interface ReviewRound {
  readonly stepIndex: number;
  readonly role: StepRole;
  readonly personaName: string;
  readonly result: StepResult;
}

/**
 * Every verdict the steps gave, newest first: the results a step kept when it ran again, then the
 * one it holds now. A plan carries no verdict, so it is no round.
 */
export function reviewRounds(steps: readonly WorkstreamStep[]): ReviewRound[] {
  const rounds = steps.flatMap((step, stepIndex) =>
    step.role === StepRole.Implement
      ? []
      : [...step.earlier, ...(step.result ? [step.result] : [])]
          .filter((result) => result.verdict !== null)
          .map((result) => ({ stepIndex, role: step.role, personaName: step.personaName, result })),
  );
  // Reversed first, so rounds stamped in the same instant stay newest first (the sort is stable).
  return rounds.reverse().sort((a, b) => b.result.at.localeCompare(a.result.at));
}

/**
 * How many times a reviewer sent the work back since the attempts last started over. Each step
 * counts its own send-backs, and a retry sets every count to 0, so neither the rounds before a retry
 * nor the gate failures that also use attempts up count here.
 */
export function rejectionsSentBack(ws: { readonly steps: readonly WorkstreamStep[] }): number {
  return ws.steps.reduce((sum, step) => sum + step.sentBack, 0);
}

/** The `detail` key of a failed workstream's card when a reviewer's rejection ended it. */
export const REVIEW_CARD_DETAIL = 'reviewRejection';

/** What that card shows of the review that failed the workstream; the summary is the whole review. */
export const ReviewCardDetail = z.object({
  role: z.enum(StepRole),
  personaName: z.string(),
  at: z.iso.datetime(),
  findings: z.array(Finding),
  summary: z.string(),
});
export type ReviewCardDetail = z.infer<typeof ReviewCardDetail>;

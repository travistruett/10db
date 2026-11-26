import { EvalManifest, EvalManifestResult, EvalsDto, type EvalSuiteDto } from '@10db/contracts';
import { TendbError } from './errors';
import type { CommandDeps } from './commands';

const REFUSED = /failed with 400: (.*)$/su;

function parse<T>(
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  raw: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success || parsed.data === undefined) {
    throw new TendbError(`${what} answered something this skill doesn't understand.`);
  }
  return parsed.data;
}

function suiteLine(s: EvalSuiteDto): string {
  const latest =
    s.latest === null ? 'no result' : s.latest.passed ? 'latest passed' : 'latest FAILED';
  return `${s.key}  ${s.format ?? 'no results'}  ${String(s.runCount)} runs  ${latest}`;
}

function summary(evals: EvalsDto): string[] {
  return [
    `Commit ${evals.commit ?? 'none'}; ${evals.assessedAt === null ? 'not assessed yet' : `assessed ${evals.assessedAt}`}.`,
    ...(evals.suites.length === 0 ? ['No suites found.'] : evals.suites.map(suiteLine)),
    `Unlinked eval files: ${String(evals.unlinked.length)}${evals.unlinked.length === 0 ? '' : `\n${evals.unlinked.map((p) => `  ${p}`).join('\n')}`}`,
    evals.gaps === null
      ? 'Gaps: unknown until a manifest is recorded.'
      : `Gaps (LLM work with no eval): ${String(evals.gaps.length)}${evals.gaps.map((g) => `\n  ${g.label} (${g.where})`).join('')}`,
  ];
}

/** Prints the evals 10db found in a project's repository, or records an assessment's manifest. */
export async function evalsCommand(args: readonly string[], deps: CommandDeps): Promise<void> {
  const [id, file] = args;
  if (!id) throw new TendbError('usage: evals <projectId> [manifest.json]');
  const base = `/projects/${id}/evals`;
  if (file === undefined) {
    const evals = parse(EvalsDto, await deps.api('GET', base), `GET ${base}`);
    for (const line of summary(evals)) deps.out(line);
    return;
  }
  let text: string;
  let raw: unknown;
  try {
    text = deps.readFile(file);
    raw = JSON.parse(text);
  } catch (e) {
    throw new TendbError(
      `Couldn't read ${file} as JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const manifest = EvalManifest.safeParse(raw);
  if (!manifest.success) {
    throw new TendbError(`${file} is not a manifest: ${manifest.error.message}`);
  }
  let answer: unknown;
  try {
    answer = await deps.api('PUT', `${base}/manifest`, manifest.data);
  } catch (e) {
    const body =
      e instanceof TendbError && e.status === 400 ? REFUSED.exec(e.message)?.[1] : undefined;
    const refusal = EvalManifestResult.safeParse(body === undefined ? undefined : safeJson(body));
    if (refusal.success && !refusal.data.ok) {
      throw new TendbError(`Refused, nothing recorded. ${refusal.data.message}`);
    }
    throw e;
  }
  const result = parse(EvalManifestResult, answer, `PUT ${base}/manifest`);
  if (!result.ok) throw new TendbError(`Refused, nothing recorded. ${result.message}`);
  deps.out(
    `Recorded ${String(manifest.data.suites.length)} suites and ${String(manifest.data.gaps.length)} gaps.`,
  );
  for (const line of summary(result.evals)) deps.out(line);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown; // checked by EvalManifestResult next
  } catch {
    return undefined;
  }
}

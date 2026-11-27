import { EvalLiveModels, EvalManifest } from '@10db/contracts';
import { modelJson } from '../folders';

/** What the model's answer made of: the manifest it describes, or why nothing is recorded. */
export type AssessAnswer =
  | { readonly ok: true; readonly manifest: EvalManifest }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads a model's reply as an `EvalManifest`: the JSON from the first `{` to the last `}` (a reply may wrap it
 * in a fence or a sentence), checked against the manifest's own schema. A reply with no JSON, a field the schema
 * refuses, or neither a suite nor a gap records nothing.
 */
export function parseAssessAnswer(reply: string): AssessAnswer {
  const parsed = EvalManifest.safeParse(withoutBadModels(modelJson(reply)));
  if (!parsed.success) {
    return { ok: false, reason: "The model's answer could not be used, so nothing changed." };
  }
  if (parsed.data.suites.length === 0 && parsed.data.gaps.length === 0) {
    return { ok: false, reason: 'The assessment found no evals and no model calls it could use.' };
  }
  return { ok: true, manifest: parsed.data };
}

/**
 * Removes a suite's `live.models` when it is not a valid `EvalLiveModels` (a reserved or malformed env name, a
 * bad id), so that suite keeps its Run without model picking and no other suite is lost. Anything not shaped like
 * a manifest is returned untouched for the manifest schema to refuse.
 */
function withoutBadModels(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('suites' in raw) || !Array.isArray(raw.suites))
    return raw;
  const suites: unknown[] = raw.suites;
  return {
    ...raw,
    suites: suites.map((suite) => {
      if (typeof suite !== 'object' || suite === null || !('live' in suite)) return suite;
      const live = suite.live;
      if (typeof live !== 'object' || live === null || !('models' in live)) return suite;
      if (EvalLiveModels.safeParse(live.models).success) return suite;
      return {
        ...suite,
        live: Object.fromEntries(Object.entries(live).filter(([key]) => key !== 'models')),
      };
    }),
  };
}

import { TrustPolicy, TrustSurface, type TrustSwitches } from '@10db/contracts';
import { coordinationLines } from './coordination';
import { LIMIT_ORDER, LIMITS } from './limits';

export interface TrustPolicyInput {
  readonly surface: TrustSurface;
  readonly projectName: string;
  readonly checkout: string;
  readonly gateCommand: string | null;
  readonly liveSystems: readonly string[];
  readonly switches: TrustSwitches;
}

/** Whether a person is in the session: a lane runs alone; a pass, Plan and chat have the builder in them. */
export function isAttended(surface: TrustSurface): boolean {
  switch (surface) {
    case TrustSurface.Lane:
      return false;
    case TrustSurface.Pass:
    case TrustSurface.Plan:
    case TrustSurface.Chat:
      return true;
  }
}

/** Whether the session works in its checkout (a lane, a pass) or only reads it (Plan, chat). */
function works(surface: TrustSurface): boolean {
  return surface === TrustSurface.Lane || surface === TrustSurface.Pass;
}

/**
 * The environment the judge reads the limits in. Every value 10db didn't write is a JSON string, so a
 * project name, a path or a live system cannot end a line or read as one of 10db's sentences.
 */
function environmentLines(input: TrustPolicyInput): string[] {
  const checkout = JSON.stringify(input.checkout);
  return [
    `Organization: one builder working alone on their own Mac, with 10db running agent sessions for the project ${JSON.stringify(input.projectName)}.`,
    works(input.surface)
      ? `Host containment: a macOS sandbox. This session writes only in ${checkout} and its own temp folder, and the commands it runs reach only the project's allowed network hosts; other folders, other sessions' copies and credentials are closed to it.`
      : `Host containment: a macOS sandbox. This session reads ${checkout} and writes nothing outside its own temp folder.`,
    ...(works(input.surface)
      ? [
          "Trusted repo: files tracked in this checkout are the session's to change; git keeps them, so deleting or rewriting them is not destroying data. Untracked or ignored files, files outside the checkout, databases and history others have are.",
        ]
      : []),
    ...(input.liveSystems.length > 0
      ? [
          `Sensitive remote targets: ${input.liveSystems.map((s) => JSON.stringify(s)).join(', ')}. These are live: treat a write to any of them as writing to a live system.`,
        ]
      : []),
  ];
}

/** One session's policy, for every judge alike (trust line §3). */
export function buildTrustPolicy(input: TrustPolicyInput): TrustPolicy {
  return TrustPolicy.parse({
    surface: input.surface,
    attended: isAttended(input.surface),
    limits: LIMIT_ORDER.map((name) => ({ name, ...LIMITS[name] })),
    environment: environmentLines(input),
    coordination: coordinationLines(input.surface, input.gateCommand),
    allow: [],
    switches: input.switches,
  });
}

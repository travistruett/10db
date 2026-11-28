import { BuilderOwns } from '@10db/contracts';

/** The questions of the ownership test that need a judge's reading. */
export const OwnershipQuestion = {
  OneWayDoor: 'one_way_door',
  ProductAndTaste: 'product_and_taste',
  Promise: 'promise',
} as const;
export type OwnershipQuestion = (typeof OwnershipQuestion)[keyof typeof OwnershipQuestion];

/** A judge's reading of one question; null when it gave no answer. */
export type OwnershipReading = { readonly yes: boolean; readonly confidence: number } | null;

const OWNER_OF_QUESTION: Readonly<Record<OwnershipQuestion, BuilderOwns>> = {
  [OwnershipQuestion.OneWayDoor]: BuilderOwns.OneWayDoor,
  [OwnershipQuestion.ProductAndTaste]: BuilderOwns.ProductAndTaste,
  [OwnershipQuestion.Promise]: BuilderOwns.Promise,
};

/**
 * What the builder owns in a change. A guardrail path hit is a fact, so it is the builder's whatever the judge
 * reads. A confident yes adds its owner; a no, at any confidence, removes nothing. A question the judge answered
 * with nothing or below the floor is doubt, which adds no owner. A question not in `judged` was not asked.
 */
export function ownershipTest(input: {
  readonly guardrailHits: number;
  readonly judged: Readonly<Partial<Record<OwnershipQuestion, OwnershipReading>>>;
  readonly floor: number;
}): { readonly owns: BuilderOwns[]; readonly doubt: OwnershipQuestion[] } {
  const owns: BuilderOwns[] = [];
  const doubt: OwnershipQuestion[] = [];
  if (input.guardrailHits > 0) owns.push(BuilderOwns.Guardrails);
  for (const question of Object.values(OwnershipQuestion)) {
    const reading = input.judged[question];
    if (reading === undefined) continue;
    if (reading === null || reading.confidence < input.floor) {
      doubt.push(question);
    } else if (reading.yes) {
      owns.push(OWNER_OF_QUESTION[question]);
    }
  }
  return { owns, doubt };
}

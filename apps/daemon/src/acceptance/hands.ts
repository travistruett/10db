/**
 * The causes that put a criterion's proof in the builder's hands (`what-reaches-the-builder` spec §1, row 6): a
 * device, the host outside the sandbox, a sign-in. A session cannot produce that proof however many rounds it
 * gets, so sending the task back for it would only spend the fix budget. A closed table: a criterion that matches
 * none is one an agent can prove by running, reading or recording something in its own lane.
 */
const HANDS_CAUSES: readonly { readonly pattern: RegExp; readonly todo: string }[] = [
  {
    pattern:
      /\b(?:real|physical|actual)\s+(?:device|iphone|ipad|phone)\b|\bon\s+(?:a|an|the|your)\s+(?:iphone|ipad|android|phone|device)\b|\btestflight\b/i,
    todo: 'Try it on your device',
  },
  {
    pattern:
      /\bon\s+(?:the|your)\s+(?:host|mac|machine)\b|\bhost\s+(?:command|machine|app)\b|\boutside\s+the\s+sandbox\b/i,
    todo: 'Run it on your Mac, outside the sandbox',
  },
  {
    pattern:
      /\b(?:signed|logged)[\s-]in\s+(?:as|to|with)\b|\bsign(?:ing)?[\s-]in\s+(?:to|with|as)\b|\blog(?:ging)?[\s-]in\s+(?:to|with|as)\b|\b(?:real|live)\s+(?:credentials?|account)\b|\b2fa\b/i,
    todo: 'Sign in yourself and try it',
  },
];

/**
 * What the builder is asked to do to prove `criterion`, or null when a session can prove it. The words say what to
 * do and what to look for, so the card needs nothing more.
 */
export function proofNeedsHands(criterion: string): string | null {
  const cause = HANDS_CAUSES.find((c) => c.pattern.test(criterion));
  return cause === undefined ? null : `${cause.todo}, then check that: ${criterion}`;
}

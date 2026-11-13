import { LimitName, type PolicyLine } from '@10db/contracts';

/** The limits in the order every rendering lists them. */
export const LIMIT_ORDER: readonly LimitName[] = [
  LimitName.DestroysData,
  LimitName.SendsDataOut,
  LimitName.ReadsSecrets,
  LimitName.WritesLive,
];

/**
 * The limits' prose, in one place (trust line §2). The label leads, in the style of Claude Code's own
 * rules, so a denial that names a rule (`Auto mode: [Reading Secrets]`) names one of these.
 */
export const LIMITS: Readonly<Record<LimitName, PolicyLine>> = {
  [LimitName.DestroysData]: {
    label: "Destroying Data It Didn't Create",
    text: "Dropping or wiping a database, deleting files that existed before this session, rewriting history others have (a force push), or rm -rf on anything this session didn't make.",
  },
  [LimitName.SendsDataOut]: {
    label: 'Sending Data Out',
    text: "Sending code, files, keys or this conversation anywhere the builder didn't send them.",
  },
  [LimitName.ReadsSecrets]: {
    label: 'Reading Secrets',
    text: 'Reading .env files, keys, credentials or the macOS Keychain.',
  },
  [LimitName.WritesLive]: {
    label: 'Writing To Live Systems',
    text: "A deploy, a migration against a database that isn't local, a cloud CLI's write (aws, gcloud, kubectl, terraform apply), publishing a package, or merging a pull request. Reading from a live system is allowed: aws s3 ls, a SELECT against staging, kubectl get.",
  },
};

/** The limit whose label a denial's reason names, whole and in any case; null when it names none. */
export function limitOfDenial(reason: string | null): LimitName | null {
  if (reason === null) return null;
  const said = reason.toLowerCase();
  return LIMIT_ORDER.find((name) => namesWhole(said, LIMITS[name].label.toLowerCase())) ?? null;
}

const WORD = /[\p{L}\p{N}]/u;

/** `label` appears in `text` with no letter or digit right before or after it. */
function namesWhole(text: string, label: string): boolean {
  for (let at = text.indexOf(label); at !== -1; at = text.indexOf(label, at + 1)) {
    const before = text[at - 1] ?? '';
    const after = text[at + label.length] ?? '';
    if (!WORD.test(before) && !WORD.test(after)) return true;
  }
  return false;
}

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

/** One yes/no question per limit for 10db's judge: what it asks, and what a yes and a no mean. */
export interface LimitQuestion {
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
}

/** The questions 10db's judge asks of a call, one per limit; `call` names the call's field of the state. */
export const LIMIT_QUESTIONS: Readonly<Record<LimitName, LimitQuestion>> = {
  [LimitName.DestroysData]: {
    instructions: 'Does `call` destroy data this session did not create?',
    criteria: {
      true: 'It drops, truncates, wipes or migrates a database (local ones included), deletes a Docker volume, deletes or overwrites a file outside the checkout or an untracked file that was there before the session (such as .env), or rewrites git history others have (a force push).',
      false:
        "It only reads, or it changes tracked files in the checkout (git keeps them), files this session made, its temp folder or throwaway containers, or the databases, volumes and containers that `session` names as this session's own.",
    },
  },
  [LimitName.SendsDataOut]: {
    instructions:
      'Does `call` send code, files, keys or the conversation somewhere the builder did not send them?',
    criteria: {
      true: 'It uploads or posts file contents, secrets or code to a host outside this Mac: a paste or transfer site, a webhook, an email, a copy to another machine.',
      false:
        'It sends nothing out: it runs locally, talks only to local containers or localhost, or only downloads (packages, web pages).',
    },
  },
  [LimitName.ReadsSecrets]: {
    instructions: 'Does `call` read the value of a secret?',
    criteria: {
      true: "It reads a .env file (not an example one), a private key, a credentials file, the macOS Keychain, or a secret from a container's environment.",
      false:
        'It reads code or config that only names secret variables, an example env file, or nothing secret.',
    },
  },
  [LimitName.WritesLive]: {
    instructions: 'Does `call` change a live system?',
    criteria: {
      true: 'It deploys, migrates or writes to a database that is not local, runs a cloud CLI write (aws, gcloud, kubectl, terraform apply), publishes a package, or merges a pull request.',
      false:
        'It works only on this Mac (builds, tests, generators, local containers and their databases), or it only reads from a live system.',
    },
  },
};

/**
 * The question asked only when the state holds a precedent the hook judge picked for the call. It narrows what
 * the limits leave unclear and never answers one of them.
 */
export const PRECEDENT_APPLIES_QUESTION: LimitQuestion = {
  instructions: 'Is `call` the kind of command `builder_precedent` describes, and nothing more?',
  criteria: {
    true: 'It is the same program and target, with arguments of the kind the examples show.',
    false:
      'It is another target or script, a host, a path outside the checkout, an option that changes what it reaches, or a further command.',
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

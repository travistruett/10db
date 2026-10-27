import {
  AccountInput,
  AccountKind,
  isMetered,
  type AccountConfig,
  type SupportedAccountKind,
} from '@10db/contracts';

export interface ModelMapRow {
  readonly alias: string;
  readonly modelId: string;
}

/** What the account fields edit: plain strings and booleans, turned into an `AccountInput` on submit. */
export interface AccountFormValues {
  readonly kind: SupportedAccountKind;
  readonly label: string;
  readonly payer: string;
  readonly laneCap: string;
  /** Empty means no cap. */
  readonly monthlyCapUsd: string;
  readonly organization: string;
  readonly region: string;
  readonly bedrockAuth: 'profile' | 'bearer';
  readonly awsProfile: string;
  readonly baseUrl: string;
  readonly modelMap: readonly ModelMapRow[];
  readonly aliases: readonly string[];
}

export function emptyAccountForm(kind: SupportedAccountKind): AccountFormValues {
  return {
    kind,
    label: '',
    payer: '',
    laneCap: '4',
    monthlyCapUsd: '',
    organization: '',
    region: '',
    bedrockAuth: 'profile',
    awsProfile: '',
    baseUrl: '',
    modelMap: [],
    aliases: [],
  };
}

export type AccountFormResult =
  | { readonly ok: true; readonly input: AccountConfig }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

function modelChoice(values: AccountFormValues): Record<string, unknown> {
  const rows = values.modelMap.filter((r) => r.alias.trim() !== '' || r.modelId.trim() !== '');
  return {
    ...(rows.length > 0
      ? { modelMap: Object.fromEntries(rows.map((r) => [r.alias.trim(), r.modelId])) }
      : {}),
    ...(values.aliases.length > 0 ? { aliases: [...values.aliases] } : {}),
  };
}

function settingsOf(values: AccountFormValues): Record<string, unknown> {
  const choice = modelChoice(values);
  switch (values.kind) {
    case AccountKind.ClaudeSubscription:
    case AccountKind.AnthropicApiKey:
      return choice;
    case AccountKind.Bedrock:
      return {
        ...choice,
        region: values.region.trim(),
        awsProfile: values.bedrockAuth === 'profile' ? values.awsProfile.trim() : null,
      };
    case AccountKind.Gateway:
      return { ...choice, baseUrl: values.baseUrl.trim() };
  }
}

function inputOf(values: AccountFormValues): Record<string, unknown> {
  const laneCap = values.laneCap.trim();
  const cap = values.monthlyCapUsd.trim();
  const organization = values.organization.trim();
  return {
    kind: values.kind,
    label: values.label,
    payer: values.payer,
    ...(laneCap === '' ? {} : { laneCap: Number(laneCap) }),
    ...(isMetered(values.kind) && cap !== '' ? { monthlyCapUsd: Number(cap) } : {}),
    ...(values.kind !== AccountKind.Gateway && isMetered(values.kind) && organization !== ''
      ? { expectedIdentity: organization }
      : {}),
    settings: settingsOf(values),
  };
}

/** Zod words a bad alias as an invalid record key, which tells the builder nothing. */
const MODEL_ALIAS_MESSAGE = 'Use a lowercase model alias such as sonnet';

const BASE_URL_MESSAGE = 'Enter an https URL with no credentials, query or fragment';

function messageOf(field: string, issue: { code: string; message: string }): string {
  if (field === 'modelMap' && issue.code === 'invalid_key') return MODEL_ALIAS_MESSAGE;
  if (field === 'baseUrl') return BASE_URL_MESSAGE;
  return issue.message;
}

/** The form field a zod issue at `path` belongs to. */
function fieldOf(path: readonly PropertyKey[]): string {
  const [head, second] = path;
  if (head === 'settings') return typeof second === 'string' ? second : 'settings';
  if (head === 'expectedIdentity') return 'organization';
  return typeof head === 'string' ? head : 'kind';
}

/** The values as the zod output, defaults filled, or each failing field's first message. */
export function toAccountInput(values: AccountFormValues): AccountFormResult {
  const parsed = AccountInput.safeParse(inputOf(values));
  if (parsed.success) return { ok: true, input: parsed.data };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = fieldOf(issue.path);
    errors[field] ??= messageOf(field, issue);
  }
  return { ok: false, errors };
}

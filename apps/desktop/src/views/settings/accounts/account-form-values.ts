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
  const cap = values.monthlyCapUsd.trim();
  const organization = values.organization.trim();
  return {
    kind: values.kind,
    label: values.label,
    payer: values.payer,
    laneCap: Number(values.laneCap.trim()),
    ...(isMetered(values.kind) && cap !== '' ? { monthlyCapUsd: Number(cap) } : {}),
    ...(values.kind !== AccountKind.Gateway && isMetered(values.kind) && organization !== ''
      ? { expectedIdentity: organization }
      : {}),
    settings: settingsOf(values),
  };
}

/** Errors with no field of their own show in the modal's alert under this key. */
export const FORM_ERROR = 'form';

/** What to do about each field, in the builder's words; zod's own text is for developers. */
const FIELD_MESSAGE: Readonly<Record<string, string>> = {
  label: 'Enter a label of up to 80 characters',
  payer: 'Keep the payer under 200 characters',
  laneCap: 'Enter a whole number from 1 to 16',
  monthlyCapUsd: 'Enter a dollar amount above zero, or leave it empty',
  organization: 'Enter an organization of up to 200 characters, or leave it empty',
  region: 'Enter an AWS region such as us-west-2',
  awsProfile: 'Enter an AWS profile name: letters, digits, dots, dashes or underscores',
  baseUrl: 'Enter an https URL with no credentials, query or fragment',
  modelMap: 'Enter a lowercase alias such as sonnet and a model ID for each row',
  aliases: 'Use lowercase aliases such as sonnet',
};
const DUPLICATE_ALIAS_MESSAGE = 'Each alias can appear once';
const EMPTY_LABEL_MESSAGE = 'Enter a label';

function messageOf(
  field: string,
  issue: { readonly code: string; readonly message: string },
  values: AccountFormValues,
): string {
  if (field === 'label' && values.label.trim() === '') return EMPTY_LABEL_MESSAGE;
  return FIELD_MESSAGE[field] ?? issue.message;
}

/** The form field a zod issue at `path` belongs to; a path with none maps to `FORM_ERROR`. */
function fieldOf(path: readonly PropertyKey[]): string {
  const [head, second] = path;
  const name = head === 'settings' ? second : head;
  if (name === 'expectedIdentity') return 'organization';
  return typeof name === 'string' && name in FIELD_MESSAGE ? name : FORM_ERROR;
}

function hasDuplicateAlias(values: AccountFormValues): boolean {
  const aliases = values.modelMap.map((r) => r.alias.trim()).filter((a) => a !== '');
  return new Set(aliases).size < aliases.length;
}

/** The values as the zod output, defaults filled, or each failing field's message. */
export function toAccountInput(values: AccountFormValues): AccountFormResult {
  const parsed = AccountInput.safeParse(inputOf(values));
  const errors: Record<string, string> = {};
  if (hasDuplicateAlias(values)) errors['modelMap'] = DUPLICATE_ALIAS_MESSAGE;
  if (parsed.success && Object.keys(errors).length === 0) return { ok: true, input: parsed.data };
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = fieldOf(issue.path);
      errors[field] ??= messageOf(field, issue, values);
    }
  }
  return { ok: false, errors };
}

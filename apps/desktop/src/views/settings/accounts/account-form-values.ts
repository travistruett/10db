import {
  AccountInput,
  AccountKind,
  AccountPatch,
  DEFAULT_ACCOUNT_LANE_CAP,
  isMetered,
  parseAccountSettings,
  type AccountConfig,
  type AccountDto,
  type ModelTier,
  type SupportedAccountKind,
} from '@10db/contracts';

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
  /** The model ID the account runs for each tier; a tier that is absent or blank is chosen automatically. */
  readonly tierOverrides: Readonly<Partial<Record<ModelTier, string>>>;
}

export function emptyAccountForm(kind: SupportedAccountKind): AccountFormValues {
  return {
    kind,
    label: '',
    payer: '',
    laneCap: String(DEFAULT_ACCOUNT_LANE_CAP),
    monthlyCapUsd: '',
    organization: '',
    region: '',
    bedrockAuth: 'profile',
    awsProfile: '',
    baseUrl: '',
    tierOverrides: {},
  };
}

export type AccountFormResult =
  | { readonly ok: true; readonly input: AccountConfig }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

function modelChoice(values: AccountFormValues): Record<string, unknown> {
  const overrides = Object.entries(values.tierOverrides).filter(([, model]) => model.trim() !== '');
  return overrides.length > 0 ? { tierOverrides: Object.fromEntries(overrides) } : {};
}

function settingsOf(values: AccountFormValues): Record<string, unknown> {
  const choice = modelChoice(values);
  switch (values.kind) {
    case AccountKind.ClaudeSubscription:
    case AccountKind.AnthropicApiKey:
    case AccountKind.CodexSignin:
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
  payer: 'Keep the payer up to 200 characters',
  laneCap: 'Enter a whole number from 1 to 16',
  monthlyCapUsd: 'Enter a dollar amount above zero and up to $1,000,000, or leave it empty',
  organization: 'Enter an organization of up to 200 characters, or leave it empty',
  region: 'Enter an AWS region such as us-west-2',
  awsProfile: 'Enter an AWS profile name: letters, digits, dots, dashes or underscores',
  baseUrl: 'Enter an https URL with no credentials, query or fragment',
  tierOverrides: 'Enter a model ID of up to 200 characters, not a tier name',
};
const EMPTY_LABEL_MESSAGE = 'Enter a label';

function messageOf(
  field: string,
  issue: { readonly message: string },
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

/** The values as the zod output, defaults filled, or each failing field's message. */
export function toAccountInput(values: AccountFormValues): AccountFormResult {
  const parsed = AccountInput.safeParse(inputOf(values));
  if (parsed.success) return { ok: true, input: parsed.data };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = fieldOf(issue.path);
    errors[field] ??= messageOf(field, issue, values);
  }
  return { ok: false, errors };
}

/** The values an account's edit form starts from. The organization is edited by the identity check, not here. */
export function formValuesOf(account: AccountDto): AccountFormValues {
  const settings = account.settings;
  return {
    kind: account.kind,
    label: account.label,
    payer: account.payer,
    laneCap: String(account.laneCap),
    monthlyCapUsd: account.monthlyCapUsd === null ? '' : String(account.monthlyCapUsd),
    organization: '',
    region: 'region' in settings ? settings.region : '',
    bedrockAuth: 'awsProfile' in settings && settings.awsProfile === null ? 'bearer' : 'profile',
    awsProfile: 'awsProfile' in settings ? (settings.awsProfile ?? '') : '',
    baseUrl: 'baseUrl' in settings ? settings.baseUrl : '',
    tierOverrides: settings.tierOverrides ?? {},
  };
}

export type AccountPatchResult =
  | {
      /** Null when nothing changed. */
      readonly ok: true;
      readonly patch: AccountPatch | null;
    }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** Settings as a string that ignores key order and an empty set of tier overrides, which the daemon treats as none. */
function settingsKey(settings: unknown): string {
  return JSON.stringify(settings, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.filter(([k, v]) => !(k === 'tierOverrides' && isEmpty(v))));
  });
}

function isEmpty(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length === 0;
}

/**
 * What to send to change `account` into `values`: only the fields that differ, with the settings whole
 * when any setting differs, as `PATCH` requires. A cleared monthly cap is `null`; a subscription never
 * sends a cap. The patch is null when nothing changed.
 */
export function toAccountPatch(account: AccountDto, values: AccountFormValues): AccountPatchResult {
  const checked = toAccountInput(values);
  if (!checked.ok) return checked;
  const input = checked.input;
  const settings = parseAccountSettings(account.kind, input.settings);
  const monthlyCap = 'monthlyCapUsd' in input ? input.monthlyCapUsd : null;
  const changes = {
    ...(input.label !== account.label ? { label: input.label } : {}),
    ...(input.payer !== account.payer ? { payer: input.payer } : {}),
    ...(input.laneCap !== account.laneCap ? { laneCap: input.laneCap } : {}),
    ...(isMetered(account.kind) && monthlyCap !== account.monthlyCapUsd
      ? { monthlyCapUsd: monthlyCap }
      : {}),
    ...(settingsKey(settings) !== settingsKey(account.settings) ? { settings } : {}),
  };
  if (Object.keys(changes).length === 0) return { ok: true, patch: null };
  const patch = AccountPatch.safeParse(changes);
  return patch.success
    ? { ok: true, patch: patch.data }
    : { ok: false, errors: { [FORM_ERROR]: 'Those changes were not accepted' } };
}

import { AccountKind, isMetered, type AccountId } from '@10db/contracts';
import { SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import { ACCOUNT_KIND_LABEL } from '../account-kind-label';
import type { AccountFormValues } from './account-form-values';
import { TierOverrides } from './tier-overrides';

export type AccountFormMode = 'create' | 'edit';

type Errors = Readonly<Record<string, string>>;

/** The fields an account of `values.kind` takes. The kind itself is chosen, or fixed, outside. */
export function AccountFields({
  values,
  onChange,
  errors,
  mode,
  accountId,
}: {
  readonly values: AccountFormValues;
  readonly onChange: (next: AccountFormValues) => void;
  readonly errors: Errors;
  readonly mode: AccountFormMode;
  /** The account being edited; null while it is being created, when it has no list of models yet. */
  readonly accountId: AccountId | null;
}) {
  const metered = isMetered(values.kind);
  const text =
    (field: 'label' | 'payer' | 'laneCap' | 'monthlyCapUsd' | 'organization' | 'region') =>
    (e: { currentTarget: { value: string } }) => {
      onChange({ ...values, [field]: e.currentTarget.value });
    };
  return (
    <Stack gap="md">
      {mode === 'edit' ? (
        <TextInput
          size="md"
          label="Kind"
          description="Fixed when the account is created."
          readOnly
          value={ACCOUNT_KIND_LABEL[values.kind]}
        />
      ) : null}
      <TextInput
        size="md"
        label="Label"
        description="How this account is named in pickers and lists."
        value={values.label}
        error={errors['label']}
        onChange={text('label')}
      />
      <TextInput
        size="md"
        label="Paid by"
        description="Who pays for this account, such as a client. Leave empty if you do."
        value={values.payer}
        error={errors['payer']}
        onChange={text('payer')}
      />
      <TextInput
        size="md"
        label="Lane cap"
        description="The most sessions that run on this account at once."
        inputMode="numeric"
        value={values.laneCap}
        error={errors['laneCap']}
        onChange={text('laneCap')}
      />
      {metered ? (
        <TextInput
          size="md"
          label="Monthly cap (USD)"
          description="10db stops starting sessions on this account at this spend each month. Leave empty for no cap."
          inputMode="decimal"
          value={values.monthlyCapUsd}
          error={errors['monthlyCapUsd']}
          onChange={text('monthlyCapUsd')}
        />
      ) : null}
      {mode === 'create' &&
      (values.kind === AccountKind.AnthropicApiKey || values.kind === AccountKind.Bedrock) ? (
        <TextInput
          size="md"
          label="Organization"
          description="The organization Claude Code must report for this account's key. Leave empty to set it later."
          value={values.organization}
          error={errors['organization']}
          onChange={text('organization')}
        />
      ) : null}
      {values.kind === AccountKind.Bedrock ? (
        <>
          <TextInput
            size="md"
            label="Region"
            description="The AWS region Bedrock runs in, such as us-west-2."
            value={values.region}
            error={errors['region']}
            onChange={text('region')}
          />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Sign in with
            </Text>
            <SegmentedControl
              size="md"
              aria-label="Sign in with"
              value={values.bedrockAuth}
              data={[
                { value: 'profile', label: 'AWS profile' },
                { value: 'bearer', label: 'Bearer token' },
              ]}
              onChange={(next) => {
                onChange({ ...values, bedrockAuth: next === 'bearer' ? 'bearer' : 'profile' });
              }}
            />
            {mode === 'edit' ? (
              <Text size="xs" c="dimmed">
                Switching to an AWS profile forgets any stored bearer token. Switching back needs
                the token pasted again.
              </Text>
            ) : null}
          </Stack>
          {values.bedrockAuth === 'profile' ? (
            <TextInput
              size="md"
              label="AWS profile"
              description="The profile name in your AWS config that sessions use."
              value={values.awsProfile}
              error={errors['awsProfile']}
              onChange={(e) => {
                onChange({ ...values, awsProfile: e.currentTarget.value });
              }}
            />
          ) : null}
        </>
      ) : null}
      {values.kind === AccountKind.Gateway ? (
        <TextInput
          size="md"
          label="Base URL"
          description="The gateway's https endpoint, with no credentials in it."
          value={values.baseUrl}
          error={errors['baseUrl']}
          onChange={(e) => {
            onChange({ ...values, baseUrl: e.currentTarget.value });
          }}
        />
      ) : null}
      {mode === 'edit' && accountId !== null ? (
        <TierOverrides
          accountId={accountId}
          values={values}
          onChange={onChange}
          error={errors['tierOverrides']}
        />
      ) : null}
    </Stack>
  );
}

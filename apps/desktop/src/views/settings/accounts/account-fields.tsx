import { AccountKind, isMetered, type AccountId } from '@10db/contracts';
import { SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
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
    <Stack gap="sm">
      <TextInput
        label="Label"
        description="The name pickers and lists show."
        value={values.label}
        error={errors['label']}
        onChange={text('label')}
      />
      <TextInput
        label="Paid By"
        description="Who pays, such as a client"
        placeholder="Optional"
        value={values.payer}
        error={errors['payer']}
        onChange={text('payer')}
      />
      <TextInput
        label="Lane Cap"
        description="Most sessions running at once"
        inputMode="numeric"
        value={values.laneCap}
        error={errors['laneCap']}
        onChange={text('laneCap')}
      />
      {metered ? (
        <TextInput
          label="Monthly Cap (USD)"
          description="Sessions stop starting at this spend each month"
          placeholder="Optional"
          inputMode="decimal"
          value={values.monthlyCapUsd}
          error={errors['monthlyCapUsd']}
          onChange={text('monthlyCapUsd')}
        />
      ) : null}
      {mode === 'create' &&
      (values.kind === AccountKind.AnthropicApiKey || values.kind === AccountKind.Bedrock) ? (
        <TextInput
          label="Organization"
          description="What Claude Code must report for this key"
          placeholder="Optional"
          value={values.organization}
          error={errors['organization']}
          onChange={text('organization')}
        />
      ) : null}
      {values.kind === AccountKind.Bedrock ? (
        <>
          <TextInput
            label="Region"
            description="Such as us-west-2"
            value={values.region}
            error={errors['region']}
            onChange={text('region')}
          />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Sign In With
            </Text>
            <SegmentedControl
              aria-label="Sign In With"
              value={values.bedrockAuth}
              data={[
                { value: 'profile', label: 'AWS Profile' },
                { value: 'bearer', label: 'Bearer Token' },
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
              label="AWS Profile"
              description="From your AWS config"
              value={values.awsProfile}
              error={errors['awsProfile']}
              onChange={(e) => {
                onChange({ ...values, awsProfile: e.currentTarget.value });
              }}
            />
          ) : null}
        </>
      ) : null}
      {mode === 'edit' && accountId !== null ? (
        <TierOverrides accountId={accountId} values={values} onChange={onChange} />
      ) : null}
    </Stack>
  );
}

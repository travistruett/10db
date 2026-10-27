import { AccountKind, isMetered } from '@10db/contracts';
import {
  ActionIcon,
  Button,
  Group,
  SegmentedControl,
  Stack,
  TagsInput,
  Text,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useEffect, useId, useRef } from 'react';
import { ACCOUNT_KIND_LABEL } from '../account-kind-label';
import type { AccountFormValues } from './account-form-values';

export type AccountFormMode = 'create' | 'edit';

type Errors = Readonly<Record<string, string>>;

function ModelMapRows({
  values,
  onChange,
  error,
}: {
  readonly values: AccountFormValues;
  readonly onChange: (next: AccountFormValues) => void;
  readonly error: string | undefined;
}) {
  const errorId = useId();
  const container = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // Which control takes focus once the rows it belongs to have rendered.
  const pendingFocus = useRef<number | 'add' | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === 'add') addButton.current?.focus();
    else
      container.current
        ?.querySelector<HTMLInputElement>(`[data-alias-row="${String(target)}"]`)
        ?.focus();
  });
  const setRow = (index: number, row: { alias: string; modelId: string }) => {
    onChange({ ...values, modelMap: values.modelMap.map((r, i) => (i === index ? row : r)) });
  };
  const invalid = error
    ? { withAria: false, 'aria-invalid': true, 'aria-describedby': errorId }
    : {};
  return (
    <Stack gap="xs" ref={container}>
      <div>
        <Text size="sm" fw={500}>
          Model map
        </Text>
        <Text size="xs" c="dimmed">
          The channel&apos;s own model ID for each alias, such as sonnet. Sessions asking for the
          alias use the ID instead.
        </Text>
      </div>
      {values.modelMap.map((row, index) => (
        <Group key={index} gap="xs" wrap="nowrap" align="flex-start">
          <TextInput
            size="md"
            aria-label={`Alias, row ${String(index + 1)}`}
            data-alias-row={index}
            placeholder="sonnet"
            value={row.alias}
            {...invalid}
            onChange={(e) => {
              setRow(index, { ...row, alias: e.currentTarget.value });
            }}
          />
          <TextInput
            size="md"
            style={{ flex: 1 }}
            aria-label={`Model ID, row ${String(index + 1)}`}
            placeholder="anthropic/claude-sonnet"
            value={row.modelId}
            {...invalid}
            onChange={(e) => {
              setRow(index, { ...row, modelId: e.currentTarget.value });
            }}
          />
          <ActionIcon
            size={36}
            variant="subtle"
            color="gray"
            aria-label={
              row.alias.trim() === '' ||
              values.modelMap.filter((r) => r.alias.trim() === row.alias.trim()).length > 1
                ? `Remove row ${String(index + 1)} mapping`
                : `Remove ${row.alias} mapping`
            }
            onClick={() => {
              pendingFocus.current = index < values.modelMap.length - 1 ? index : 'add';
              onChange({ ...values, modelMap: values.modelMap.filter((_, i) => i !== index) });
            }}
          >
            <IconTrash size={20} stroke={1.5} />
          </ActionIcon>
        </Group>
      ))}
      {error ? (
        <Text id={errorId} size="xs" c="red" role="alert">
          {error}
        </Text>
      ) : null}
      <Group>
        <Button
          ref={addButton}
          size="sm"
          variant="subtle"
          leftSection={<IconPlus size={16} stroke={1.5} />}
          onClick={() => {
            pendingFocus.current = values.modelMap.length;
            onChange({ ...values, modelMap: [...values.modelMap, { alias: '', modelId: '' }] });
          }}
        >
          Add model mapping
        </Button>
      </Group>
    </Stack>
  );
}

/** The fields an account of `values.kind` takes. The kind itself is chosen, or fixed, outside. */
export function AccountFields({
  values,
  onChange,
  errors,
  mode,
}: {
  readonly values: AccountFormValues;
  readonly onChange: (next: AccountFormValues) => void;
  readonly errors: Errors;
  readonly mode: AccountFormMode;
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
      <ModelMapRows values={values} onChange={onChange} error={errors['modelMap']} />
      <TagsInput
        size="md"
        label="Offered aliases"
        description="The model aliases this account offers. Leave empty to offer every alias."
        value={[...values.aliases]}
        error={errors['aliases']}
        onChange={(aliases) => {
          onChange({ ...values, aliases });
        }}
      />
    </Stack>
  );
}

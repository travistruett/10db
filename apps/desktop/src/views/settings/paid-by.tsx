import { AccountId, AccountKind, powersDecisions, type JudgeStatusDto } from '@10db/contracts';
import { Anchor, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import { usePatchJudge } from '../../daemon/judge-queries';
import { AccountSelect } from './account-select';
import { AddAccountModal } from './accounts/add-account-modal';
import { cantRunDecisions } from './accounts/used-by';
import { ConnectionStatus, ConnectionTone } from './connection-status';
import { useFocusTarget } from './focus-target';
import { SettingsSectionKey } from './sections';
import { SettingRow } from './setting-row';

function AccountLink({
  account,
  children,
}: {
  readonly account: NonNullable<JudgeStatusDto['account']>;
  readonly children: string;
}) {
  return (
    <Anchor
      size="xs"
      renderRoot={(props) => (
        <Link
          {...props}
          to="/settings/$section"
          params={{ section: SettingsSectionKey.Accounts }}
          search={{ focus: account.id }}
        />
      )}
    >
      {children}
    </Anchor>
  );
}

/** The state of the account that pays for decisions, beside the select. */
function PaidByState({
  account,
  off,
}: {
  readonly account: NonNullable<JudgeStatusDto['account']>;
  readonly off: boolean;
}) {
  if (account.secretState === 'set')
    return (
      <Stack gap={2}>
        <Group gap="sm">
          <ConnectionStatus
            tone={off ? ConnectionTone.Off : ConnectionTone.Works}
            label={
              account.awsProfile ? `Signs in with AWS profile ${account.awsProfile}` : 'Key set'
            }
          />
          <AccountLink account={account}>View account</AccountLink>
        </Group>
        {off || !account.fallback ? null : (
          <ConnectionStatus
            tone={ConnectionTone.NeedsYou}
            label={`Decisions are falling back to rules: ${account.fallback}`}
          />
        )}
      </Stack>
    );
  const problem =
    account.secretState === 'changed'
      ? 'Key changed outside 10db: decisions use 10db’s rules until it is set again'
      : 'No key: decisions use 10db’s rules until one is set';
  return (
    <Stack gap={2}>
      <ConnectionStatus tone={ConnectionTone.NeedsYou} label={problem} />
      <AccountLink account={account}>Set the key again in Accounts</AccountLink>
    </Stack>
  );
}

/** Which account answers decisions: an OpenRouter, Anthropic API key or Bedrock account, whose credential 10db signs them with. */
export function PaidBy({
  status,
  disabled,
}: {
  readonly status: JudgeStatusDto;
  readonly disabled: boolean;
}) {
  const accounts = useAccounts();
  const patch = usePatchJudge();
  const { ref } = useFocusTarget<HTMLDivElement>('paid-by');
  const [adding, setAdding] = useState(false);
  const live = (accounts.data ?? []).filter((a) => !a.archived);
  const canDecide = live.some((a) => powersDecisions(a.kind));
  return (
    <div ref={ref}>
      <SettingRow
        label="Paid by"
        description="The account whose API answers 10db’s decisions: OpenRouter, an Anthropic API key or Bedrock. A plan login has no API for quick decisions."
      >
        {accounts.isPending ? (
          <Loader size="sm" aria-label="Loading accounts" />
        ) : accounts.data === undefined ? (
          <Text size="sm" c="red" role="alert">
            Accounts could not be loaded. Check that the daemon is running.
          </Text>
        ) : canDecide ? (
          <Stack gap={4}>
            <AccountSelect
              aria-label="Paid by"
              placeholder="Pick an account"
              accounts={live}
              isDisabled={cantRunDecisions}
              value={status.config.accountId}
              allowDeselect={false}
              disabled={disabled || patch.isPending}
              onChange={(value) => {
                if (value !== null && value !== status.config.accountId)
                  patch.mutate({ accountId: AccountId.parse(value) });
              }}
            />
            {status.account === null ? null : (
              <PaidByState account={status.account} off={status.off} />
            )}
          </Stack>
        ) : (
          <Stack gap="xs" align="flex-end">
            <Text size="sm">No account can run decisions yet.</Text>
            <Button
              onClick={() => {
                setAdding(true);
              }}
            >
              Add OpenRouter Account
            </Button>
          </Stack>
        )}
      </SettingRow>
      <AddAccountModal
        opened={adding}
        initialKind={AccountKind.OpenRouter}
        onClose={() => {
          setAdding(false);
        }}
        onCreated={() => {
          setAdding(false);
        }}
      />
    </div>
  );
}

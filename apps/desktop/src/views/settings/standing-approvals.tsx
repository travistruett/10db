import { PrecedentState, type ProjectId, type ProjectPrecedentsDto } from '@10db/contracts';
import { Alert, Anchor, Button, Code, Collapse, Group, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Link } from '@tanstack/react-router';
import { useJudgeStatus } from '../../daemon/judge-queries';
import { usePatchPrecedent, usePrecedents } from '../../daemon/trust-queries';
import { SettingRow, SettingsCard } from './setting-row';
import { SettingsSectionKey } from './sections';
import {
  NOT_ROUTINE_DESCRIPTION,
  PRECEDENT_REMOVE_NOTE,
  PRECEDENT_SCOPE_LABELS,
  STANDING_APPROVALS_DESCRIPTION,
  STANDING_APPROVALS_EMPTY,
  STANDING_APPROVALS_NEEDS_ACCOUNT,
} from './trust-rows';

type Precedent = ProjectPrecedentsDto['precedents'][number];

/** Calls are the agent's text: shown as text on one line each, never run or parsed. */
function CallLines({ calls }: { readonly calls: readonly string[] }) {
  return (
    <Stack gap={4}>
      {calls.map((call, index) => (
        <Code key={index} block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {call}
        </Code>
      ))}
    </Stack>
  );
}

/** The last calls a standing approval allowed, folded until asked for. */
function LastAllowed({ precedent }: { readonly precedent: Precedent }) {
  const [open, { toggle }] = useDisclosure(false);
  if (precedent.lastAllowed.length === 0) return null;
  return (
    <Stack gap={4}>
      <Anchor
        component="button"
        type="button"
        size="xs"
        aria-expanded={open}
        onClick={toggle}
        style={{ alignSelf: 'flex-start' }}
      >
        {open ? 'Hide' : 'Show'} the Last {precedent.lastAllowed.length} Calls It Allowed
      </Anchor>
      <Collapse expanded={open}>
        <Stack gap={4}>
          {precedent.lastAllowed.map((allowed, index) => (
            <Stack key={index} gap={2}>
              <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {allowed.call}
              </Code>
              <Text size="xs" c="dimmed">
                {new Date(allowed.at).toLocaleString()}
              </Text>
            </Stack>
          ))}
        </Stack>
      </Collapse>
    </Stack>
  );
}

function usageLine(precedent: Precedent): string {
  const uses = `Used ${String(precedent.uses)} ${precedent.uses === 1 ? 'time' : 'times'}`;
  const last =
    precedent.lastUsedAt === null
      ? 'never used'
      : `last used ${new Date(precedent.lastUsedAt).toLocaleDateString()}`;
  return `${PRECEDENT_SCOPE_LABELS[precedent.scope]} · ${uses}, ${last}`;
}

function ActiveRow({
  precedent,
  busy,
  onRemove,
}: {
  readonly precedent: Precedent;
  readonly busy: boolean;
  readonly onRemove: () => void;
}) {
  return (
    <SettingRow
      label={precedent.kind}
      description={usageLine(precedent)}
      stacked
      below={
        <Stack gap="xs">
          {precedent.state === PrecedentState.Paused ? (
            <Text size="xs" c="yellow">
              Paused after {String(precedent.conflicts)} calls 10db stopped at a limit. Calls of
              this kind are judged without it. Answer the card in the Inbox to keep it.
            </Text>
          ) : null}
          {precedent.examples.length === 0 ? null : <CallLines calls={precedent.examples} />}
          <LastAllowed precedent={precedent} />
        </Stack>
      }
    >
      <Stack gap={4} align="flex-end">
        <Button
          variant="default"
          size="compact-sm"
          aria-label={`Remove ${precedent.kind}`}
          loading={busy}
          onClick={onRemove}
        >
          Remove
        </Button>
        <Text size="xs" c="dimmed" ta="right">
          {PRECEDENT_REMOVE_NOTE}
        </Text>
      </Stack>
    </SettingRow>
  );
}

function NotRoutineRow({
  precedent,
  busy,
  onApprove,
}: {
  readonly precedent: Precedent;
  readonly busy: boolean;
  readonly onApprove: () => void;
}) {
  const how = precedent.state === PrecedentState.Declined ? 'Kept skipping' : 'Removed';
  return (
    <SettingRow
      label={precedent.kind}
      description={`${how} · ${PRECEDENT_SCOPE_LABELS[precedent.scope]}`}
      stacked
      below={precedent.examples.length === 0 ? null : <CallLines calls={precedent.examples} />}
    >
      <Button
        variant="default"
        size="compact-sm"
        aria-label={`Approve ${precedent.kind}`}
        loading={busy}
        onClick={onApprove}
      >
        Approve
      </Button>
    </SettingRow>
  );
}

/**
 * A project's standing approvals: the kinds of command the builder made routine, each with its uses and the last
 * calls it allowed and a Remove, and under them the kinds kept skipping or removed, each with an Approve.
 */
export function StandingApprovals({ projectId }: { readonly projectId: ProjectId }) {
  const precedents = usePrecedents(projectId);
  const patch = usePatchPrecedent(projectId);
  const judge = useJudgeStatus();
  const rows = precedents.data?.precedents ?? [];
  const standing = rows.filter(
    (r) => r.state === PrecedentState.Active || r.state === PrecedentState.Paused,
  );
  const notRoutine = rows.filter(
    (r) => r.state === PrecedentState.Declined || r.state === PrecedentState.Revoked,
  );
  const needsAccount = judge.data !== undefined && (judge.data.off || judge.data.account === null);
  const changing = patch.isPending ? patch.variables.id : null;
  return (
    <Stack gap="lg">
      {precedents.isError ? <Alert color="red">{precedents.error.message}</Alert> : null}
      {patch.isError ? <Alert color="red">{patch.error.message}</Alert> : null}
      <SettingsCard title="Standing Approvals" description={STANDING_APPROVALS_DESCRIPTION}>
        {needsAccount ? (
          <SettingRow label={STANDING_APPROVALS_NEEDS_ACCOUNT}>
            <Group justify="flex-end">
              <Anchor
                size="sm"
                renderRoot={(props) => (
                  <Link
                    {...props}
                    to="/settings/$section"
                    params={{ section: SettingsSectionKey.Decisions }}
                  />
                )}
              >
                Open Decisions
              </Anchor>
            </Group>
          </SettingRow>
        ) : null}
        {precedents.data !== undefined && standing.length === 0 && !needsAccount ? (
          <SettingRow label={STANDING_APPROVALS_EMPTY}>
            <></>
          </SettingRow>
        ) : null}
        {standing.map((precedent) => (
          <ActiveRow
            key={precedent.id}
            precedent={precedent}
            busy={changing === precedent.id}
            onRemove={() => {
              patch.mutate({ id: precedent.id, state: PrecedentState.Revoked });
            }}
          />
        ))}
      </SettingsCard>
      {notRoutine.length === 0 ? null : (
        <SettingsCard title="Not Routine" description={NOT_ROUTINE_DESCRIPTION}>
          {notRoutine.map((precedent) => (
            <NotRoutineRow
              key={precedent.id}
              precedent={precedent}
              busy={changing === precedent.id}
              onApprove={() => {
                patch.mutate({ id: precedent.id, state: PrecedentState.Active });
              }}
            />
          ))}
        </SettingsCard>
      )}
    </Stack>
  );
}

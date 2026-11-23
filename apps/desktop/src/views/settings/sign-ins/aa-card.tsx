import type { BenchmarkStatusDto } from '@10db/contracts';
import {
  ActionIcon,
  Button,
  Group,
  PasswordInput,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconDeviceFloppy, IconGauge, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { removeBenchmarkKey, sendBenchmarkKey } from '../../../daemon/benchmark-secret';
import {
  benchmarkKeys,
  useBenchmarkStatus,
  useSyncBenchmarks,
} from '../../../daemon/benchmark-queries';
import { useDaemon } from '../../../daemon/provider';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmModal } from '../../../shell/confirm-modal';
import { shortAgo } from '../../factory/short-ago';
import { ArtificialAnalysisCredit } from '../artificial-analysis-credit';
import { IntegrationCard, StateText } from './integration-card';

const KEY_FIELD = 'Artificial Analysis key';
const LAST_GOOD = 'Routing uses the last good scores.';

/** The card's state line, in words. */
function headline(status: BenchmarkStatusDto): string {
  if (status.off) return 'Off: 10db was started with TENDB_BENCHMARKS=off';
  if (!status.keyConfigured) return 'No key.';
  if (status.syncing) return 'Checking the key…';
  if (status.outcome === 'unauthorized') return 'AA refused this key.';
  return status.lastSuccessAt === null
    ? 'Key set'
    : `Key set · synced ${shortAgo(status.lastSuccessAt)} · ${String(status.models)} models`;
}

/** A sync that failed or was limited, said quietly: the key itself is fine. */
function syncNote(status: BenchmarkStatusDto): string | null {
  if (!status.keyConfigured || status.syncing) return null;
  const keep = status.lastSuccessAt === null ? '' : ` ${LAST_GOOD}`;
  if (status.outcome === 'rate_limited') return `Rate limited, retrying.${keep}`;
  if (status.outcome === 'failed')
    return `Sync failed: ${status.message ?? 'unknown error'}.${keep}`;
  return null;
}

function Actions({ status }: { readonly status: BenchmarkStatusDto }) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const sync = useSyncBenchmarks();
  const [key, setKey] = useState('');
  // A sent key is watched until the sync it started has ended: then it leaves the field, unless AA refused it.
  const [phase, setPhase] = useState<'idle' | 'sent' | 'checking'>('idle');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeFailure, setRemoveFailure] = useState<string | null>(null);

  if (phase === 'sent' && status.syncing) setPhase('checking');
  if (phase === 'checking' && !status.syncing) {
    setPhase('idle');
    if (status.outcome !== 'unauthorized') setKey('');
  }

  const failure = (error: unknown): string =>
    error instanceof Error ? error.message : 'The daemon did not answer';

  async function submit() {
    setBusy(true);
    setRefusal(null);
    try {
      queryClient.setQueryData(
        benchmarkKeys.status,
        await sendBenchmarkKey(client, { key: key.trim() }),
      );
      setPhase('sent');
    } catch (error) {
      setRefusal(failure(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setRemoveFailure(null);
    try {
      queryClient.setQueryData(benchmarkKeys.status, await removeBenchmarkKey(client));
      setRemoving(false);
    } catch (error) {
      setRemoveFailure(failure(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="xs">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (key.trim() !== '') void submit();
        }}
      >
        <Group align="flex-start" gap="xs" wrap="nowrap">
          <PasswordInput
            aria-label={KEY_FIELD}
            // The key itself is never shown again: a set key reads as dots until one is pasted over it.
            placeholder={
              status.keyConfigured
                ? '••••••••••••  Paste a new key to replace it'
                : 'Paste your key'
            }
            autoComplete="off"
            style={{ flex: 1 }}
            value={key}
            error={refusal ?? undefined}
            onChange={(event) => {
              setKey(event.currentTarget.value);
              setPhase('idle');
            }}
          />
          {status.keyConfigured ? (
            <Group gap={4} wrap="nowrap" mih={36}>
              <Tooltip label="Replace Key" withArrow>
                <ActionIcon
                  type="submit"
                  size="lg"
                  variant="subtle"
                  color="gray"
                  aria-label="Replace Key"
                  loading={busy}
                  disabled={key.trim() === ''}
                >
                  <IconDeviceFloppy size={18} stroke={1.5} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Sync Now" withArrow>
                <ActionIcon
                  size="lg"
                  variant="subtle"
                  color="gray"
                  aria-label="Sync Now"
                  loading={sync.isPending}
                  disabled={status.syncing}
                  onClick={() => {
                    sync.mutate();
                  }}
                >
                  <IconRefresh size={18} stroke={1.5} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Remove Key" withArrow>
                <ActionIcon
                  size="lg"
                  variant="subtle"
                  color="red"
                  aria-label="Remove Key"
                  disabled={busy}
                  onClick={() => {
                    setRemoving(true);
                  }}
                >
                  <IconTrash size={18} stroke={1.5} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ) : (
            <Button type="submit" loading={busy} disabled={key.trim() === ''}>
              Set Key
            </Button>
          )}
        </Group>
      </form>
      {sync.isError ? (
        <Text size="xs" c="dimmed">
          {sync.error.message}
        </Text>
      ) : null}
      <ConfirmModal
        opened={removing}
        title="Remove the Artificial Analysis Key?"
        confirmLabel="Remove Key"
        destructive
        loading={busy}
        error={removeFailure}
        onCancel={() => {
          setRemoving(false);
        }}
        onConfirm={() => void remove()}
      >
        10db removes the key from your Keychain and stops syncing scores. Scores already synced
        stay.
      </ConfirmModal>
    </Stack>
  );
}

/** Settings › Integrations › Artificial Analysis: the key behind the scores 10db picks models by. */
export function AaCard() {
  const query = useBenchmarkStatus();
  const status = query.data;
  const note = status ? syncNote(status) : null;
  // The card appears once its state is read, so a link's focus lands on its controls.
  if (!status && !query.isError) return <Skeleton height={90} radius="md" />;
  return (
    <IntegrationCard
      mark={<IconGauge size={20} stroke={1.5} aria-hidden />}
      name="Artificial Analysis"
      focusName="artificial-analysis"
    >
      <StateText>
        {status ? headline(status) : "Couldn't read this."}
        {note === null ? '' : ` ${note}`}
      </StateText>
      {status && !status.off ? <Actions status={status} /> : null}
      <Text size="xs" c="dimmed">
        <ArtificialAnalysisCredit />
      </Text>
    </IntegrationCard>
  );
}

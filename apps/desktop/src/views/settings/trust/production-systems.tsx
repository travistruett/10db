import {
  LIVE_SYSTEM_MAX_CHARS,
  LIVE_SYSTEMS_MAX,
  type ProjectDto,
  type LiveSystemProposalsDto,
} from '@10db/contracts';
import { Button, Group, Stack, TagsInput, Text } from '@mantine/core';
import { z } from 'zod';
import { DaemonRequestError } from '../../../daemon/client';
import {
  useLiveSystemProposals,
  useLiveSystems,
  useSetLiveSystems,
} from '../../../daemon/trust-queries';
import { SettingRow, SettingsCard } from '../setting-row';
import { PRODUCTION_DESCRIPTION } from '../trust-rows';

const RefusedList = z.object({ issues: z.array(z.object({ message: z.string() })).min(1) });

/** Why the daemon refused a list, without the field paths the builder never sees. */
function refusal(error: Error | null): string | undefined {
  if (error === null) return undefined;
  const refused = error instanceof DaemonRequestError ? RefusedList.safeParse(error.body) : null;
  return refused?.success === true
    ? [...new Set(refused.data.issues.map((issue) => issue.message))].join('; ')
    : error.message;
}

/** What 10db found in the repo, each with its source line and an Add; nothing is added without a click. */
function Proposals({
  proposals,
  disabled,
  onAdd,
}: {
  readonly proposals: LiveSystemProposalsDto['proposals'];
  readonly disabled: boolean;
  readonly onAdd: (entry: string) => void;
}) {
  if (proposals.length === 0) return null;
  return (
    <Stack gap={4} role="region" aria-label="Found in the repo">
      <Text size="xs" c="dimmed">
        10db found these in the repo
      </Text>
      {proposals.map(({ entry, source }) => (
        <Group key={entry} justify="space-between" wrap="nowrap" gap="sm">
          <Text size="sm">
            {entry}
            <Text component="span" size="xs" c="dimmed">
              {` · ${source.path}:${String(source.line)}`}
            </Text>
          </Text>
          <Button
            variant="default"
            size="compact-xs"
            aria-label={`Add ${entry}`}
            disabled={disabled}
            onClick={() => {
              onAdd(entry);
            }}
          >
            Add
          </Button>
        </Group>
      ))}
    </Stack>
  );
}

/**
 * The project's production systems: places lanes may read and the judge refuses to write to. A change is
 * sent at once and shows while it is on its way; one the daemon refuses shows why under the input and
 * leaves the saved list.
 */
export function ProductionSystems({ projectId }: { readonly projectId: ProjectDto['id'] }) {
  const live = useLiveSystems(projectId);
  const proposals = useLiveSystemProposals(projectId);
  const set = useSetLiveSystems(projectId);
  const saved = live.data?.liveSystems;
  const shown = set.isPending ? set.variables : (saved ?? []);
  return (
    <SettingsCard title="Production">
      <SettingRow
        label="Production"
        description="Places lanes may read; the judge refuses any write to them."
        help={PRODUCTION_DESCRIPTION}
        stacked
        below={
          <Proposals
            proposals={(proposals.data?.proposals ?? []).filter(
              ({ entry }) => !shown.some((listed) => listed.toLowerCase() === entry.toLowerCase()),
            )}
            disabled={saved === undefined || set.isPending}
            onAdd={(entry) => {
              set.mutate([...shown, entry]);
            }}
          />
        }
      >
        <TagsInput
          aria-label="Production"
          value={[...shown]}
          maxTags={LIVE_SYSTEMS_MAX}
          maxLength={LIVE_SYSTEM_MAX_CHARS}
          disabled={saved === undefined}
          error={live.error?.message ?? refusal(set.error)}
          onChange={(next) => {
            set.mutate(next);
          }}
        />
      </SettingRow>
    </SettingsCard>
  );
}

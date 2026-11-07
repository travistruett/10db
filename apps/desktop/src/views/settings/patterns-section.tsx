import {
  RiskTag,
  type AccountId,
  type PatternDto,
  type PatternInput,
  type ProjectDto,
} from '@10db/contracts';
import {
  ActionIcon,
  Button,
  Checkbox,
  Group,
  MultiSelect,
  Paper,
  SimpleGrid,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconTrash } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import {
  useModelSettings,
  useSetGlobalModelSettings,
  useSetProjectModelSettings,
} from '../../daemon/model-settings-queries';
import { RISK_LABEL } from '../board/risk-labels';
import { ModelSettingSelect } from './model-setting-select';
import {
  draftOf,
  inputOf,
  isRiskTag,
  isStepRole,
  moved,
  newDraft,
  type PatternDraft,
} from './pattern-drafts';
import { ROLES } from './role-labels';

interface EditorProps {
  readonly saved: readonly PatternDto[];
  /** The project's area names to choose from; null where any area name can be typed. */
  readonly areaNames: readonly string[] | null;
  readonly accountIds: readonly AccountId[] | null;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onSave: (patterns: PatternInput[], saved: () => void) => void;
}

const RISKS = Object.values(RiskTag);

function PatternCard({
  draft,
  index,
  count,
  areaNames,
  accountIds,
  onChange,
  onMove,
  onDelete,
}: {
  readonly draft: PatternDraft;
  readonly index: number;
  readonly count: number;
  readonly areaNames: readonly string[] | null;
  readonly accountIds: readonly AccountId[] | null;
  readonly onChange: (draft: PatternDraft) => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly onDelete: () => void;
}) {
  const n = String(index + 1);
  return (
    <Paper withBorder radius="md" p="md" role="group" aria-label={`Pattern ${n}`}>
      <Stack gap="sm">
        <Group align="flex-end" wrap="nowrap">
          <TextInput
            label="Name"
            flex={1}
            value={draft.name}
            onChange={(event) => {
              onChange({ ...draft, name: event.currentTarget.value });
            }}
          />
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`Move pattern ${n} up`}
            disabled={index === 0}
            onClick={() => {
              onMove(-1);
            }}
          >
            <IconArrowUp size={16} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`Move pattern ${n} down`}
            disabled={index === count - 1}
            onClick={() => {
              onMove(1);
            }}
          >
            <IconArrowDown size={16} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="red"
            aria-label={`Delete pattern ${n}`}
            onClick={onDelete}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <MultiSelect
            label="Roles"
            placeholder="Any role"
            data={ROLES.map(({ role, label }) => ({ value: role, label }))}
            value={[...draft.roles]}
            onChange={(values) => {
              onChange({ ...draft, roles: values.filter(isStepRole) });
            }}
          />
          <MultiSelect
            label="Risks"
            placeholder="Any risk"
            data={RISKS.map((risk) => ({ value: risk, label: RISK_LABEL[risk] }))}
            value={[...draft.riskTags]}
            onChange={(values) => {
              onChange({ ...draft, riskTags: values.filter(isRiskTag) });
            }}
          />
          {areaNames === null ? (
            <TagsInput
              label="Areas"
              placeholder="Any area"
              value={[...draft.areas]}
              onChange={(areas) => {
                onChange({ ...draft, areas });
              }}
            />
          ) : (
            <MultiSelect
              label="Areas"
              placeholder="Any area"
              data={[...areaNames]}
              value={[...draft.areas]}
              onChange={(areas) => {
                onChange({ ...draft, areas });
              }}
            />
          )}
          <Checkbox
            label="Only on a retry"
            mt={{ base: 0, sm: 'xl' }}
            checked={draft.retryOnly}
            onChange={(event) => {
              onChange({ ...draft, retryOnly: event.currentTarget.checked });
            }}
          />
        </SimpleGrid>
        <ModelSettingSelect
          label="Model"
          accountIds={accountIds}
          value={draft.setting}
          onChange={(setting) => {
            onChange({ ...draft, setting });
          }}
        />
      </Stack>
    </Paper>
  );
}

function PatternsEditor({ saved, areaNames, accountIds, saving, error, onSave }: EditorProps) {
  const [edited, setEdited] = useState<PatternDraft[] | null>(null);
  const added = useRef(0);
  const savedDrafts = saved.map(draftOf);
  const drafts = edited ?? savedDrafts;
  const sends = (list: readonly PatternDraft[]) => JSON.stringify(list.map(inputOf));
  const changed = edited !== null && sends(edited) !== sends(savedDrafts);
  const named = drafts.every((d) => d.name.trim() !== '');
  return (
    <Stack gap="sm">
      <Title order={5}>Patterns</Title>
      <Text size="sm" c="dimmed">
        A pattern gives work that matches it a model setting. The first one that matches wins, so
        order them with the most specific first.
      </Text>
      {drafts.length === 0 ? <Text size="sm">No patterns.</Text> : null}
      {drafts.map((draft, index) => (
        <PatternCard
          key={draft.key}
          draft={draft}
          index={index}
          count={drafts.length}
          areaNames={areaNames}
          accountIds={accountIds}
          onChange={(next) => {
            setEdited(drafts.map((d) => (d.key === draft.key ? next : d)));
          }}
          onMove={(by) => {
            setEdited(moved(drafts, index, by));
          }}
          onDelete={() => {
            setEdited(drafts.filter((d) => d.key !== draft.key));
          }}
        />
      ))}
      {error === null ? null : (
        <Text size="sm" c="red" role="alert">
          {error}
        </Text>
      )}
      <Group>
        <Button
          variant="default"
          size="xs"
          onClick={() => {
            added.current += 1;
            setEdited([...drafts, newDraft(`new-${String(added.current)}`)]);
          }}
        >
          Add pattern
        </Button>
        <Button
          size="xs"
          disabled={!changed || !named || saving}
          onClick={() => {
            onSave(drafts.map(inputOf), () => {
              setEdited(null);
            });
          }}
        >
          Save patterns
        </Button>
      </Group>
    </Stack>
  );
}

function GlobalPatterns() {
  const settings = useModelSettings(null);
  const set = useSetGlobalModelSettings();
  return (
    <PatternsEditor
      saved={settings.data?.patterns ?? []}
      areaNames={null}
      accountIds={null}
      saving={set.isPending}
      error={set.error ? `Couldn't save: ${set.error.message}` : null}
      onSave={(patterns, saved) => {
        set.mutate({ roles: [], patterns }, { onSuccess: saved });
      }}
    />
  );
}

function ProjectPatterns({ project }: { readonly project: ProjectDto }) {
  const settings = useModelSettings(project.id);
  const set = useSetProjectModelSettings(project.id);
  return (
    <PatternsEditor
      saved={settings.data?.patterns ?? []}
      areaNames={project.areas.map((area) => area.name)}
      accountIds={[project.accountId]}
      saving={set.isPending}
      error={set.error ? `Couldn't save: ${set.error.message}` : null}
      onSave={(patterns, saved) => {
        set.mutate({ roles: [], patterns }, { onSuccess: saved });
      }}
    />
  );
}

/** The patterns of one project, or of everywhere when no project is given. */
export function PatternsSection({ project }: { readonly project: ProjectDto | null }) {
  return project === null ? <GlobalPatterns /> : <ProjectPatterns project={project} />;
}

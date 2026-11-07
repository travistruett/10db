import type {
  StepRole,
  AccountId,
  ModelSetting,
  ProjectDto,
  RoleSettingDto,
} from '@10db/contracts';
import { Text } from '@mantine/core';
import {
  useModelSettings,
  useSetGlobalModelSettings,
  useSetProjectModelSettings,
} from '../../daemon/model-settings-queries';
import { ROLES } from './role-labels';
import { ModelSettingSelect } from './model-setting-select';
import { SettingRow, SettingsCard } from './setting-row';

interface RowsProps {
  readonly saved: readonly RoleSettingDto[];
  readonly accountIds: readonly AccountId[] | null;
  /** The choice that removes the role's own setting: Use global in a project, 10db's default everywhere. */
  readonly noneLabel: string;
  readonly description: (about: string) => string;
  readonly error: string | null;
  readonly onChange: (role: StepRole, setting: ModelSetting | null) => void;
}

function RoleRows({ saved, accountIds, noneLabel, description, error, onChange }: RowsProps) {
  return (
    <SettingsCard title="Model by role">
      {ROLES.map(({ role, label, about }) => (
        <SettingRow key={role} label={label} description={description(about)}>
          <ModelSettingSelect
            hideLabel
            label={`${label} model`}
            accountIds={accountIds}
            value={saved.find((s) => s.role === role)?.setting ?? null}
            noneLabel={noneLabel}
            onChange={(setting) => {
              onChange(role, setting);
            }}
          />
        </SettingRow>
      ))}
      {error === null ? null : (
        <Text size="sm" c="red" role="alert" px="md" py="sm">
          {error}
        </Text>
      )}
    </SettingsCard>
  );
}

function GlobalRoleSettings() {
  const settings = useModelSettings(null);
  const set = useSetGlobalModelSettings();
  return (
    <RoleRows
      saved={settings.data?.roles ?? []}
      accountIds={null}
      noneLabel="10db default"
      description={(about) => `${about} 10db default lets 10db pick for the role.`}
      error={set.error ? `Couldn't save: ${set.error.message}` : null}
      onChange={(role, setting) => {
        set.mutate({ roles: [{ role, setting }] });
      }}
    />
  );
}

function ProjectRoleSettings({ project }: { readonly project: ProjectDto }) {
  const settings = useModelSettings(project.id);
  const set = useSetProjectModelSettings(project.id);
  return (
    <RoleRows
      saved={settings.data?.roles ?? []}
      accountIds={[project.accountId]}
      noneLabel="Use global"
      description={(about) => `${about} Use global follows the setting for every project.`}
      error={set.error ? `Couldn't save: ${set.error.message}` : null}
      onChange={(role, setting) => {
        set.mutate({ roles: [{ role, setting }] });
      }}
    />
  );
}

/**
 * The model each role uses: one project's own, which can also fall back to the global one, or the
 * setting that applies everywhere when no project is given.
 */
export function RoleSettings({ project }: { readonly project: ProjectDto | null }) {
  return project === null ? <GlobalRoleSettings /> : <ProjectRoleSettings project={project} />;
}

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
  readonly inherits: boolean;
  readonly error: string | null;
  readonly onChange: (role: StepRole, setting: ModelSetting | null) => void;
}

function RoleRows({ saved, accountIds, inherits, error, onChange }: RowsProps) {
  return (
    <SettingsCard title="Model by role">
      {ROLES.map(({ role, label, about }) => {
        const value = saved.find((s) => s.role === role)?.setting ?? null;
        return (
          <SettingRow
            key={role}
            label={label}
            description={
              inherits
                ? `${about} Use global follows the setting for every project.`
                : `${about} Unset, 10db picks for the role.`
            }
          >
            {inherits ? (
              <ModelSettingSelect
                hideLabel
                label={`${label} model`}
                accountIds={accountIds}
                value={value}
                noneLabel="Use global"
                onChange={(setting) => {
                  onChange(role, setting);
                }}
              />
            ) : (
              <ModelSettingSelect
                hideLabel
                label={`${label} model`}
                placeholder="10db picks"
                accountIds={accountIds}
                value={value}
                onChange={(setting) => {
                  onChange(role, setting);
                }}
              />
            )}
          </SettingRow>
        );
      })}
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
      inherits={false}
      error={set.error ? `Couldn't save: ${set.error.message}` : null}
      onChange={(role, setting) => {
        if (setting !== null) set.mutate({ roles: [{ role, setting }] });
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
      inherits
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

import type { ProjectDto } from '@10db/contracts';
import { Switch } from '@mantine/core';
import { useSetShapeJev, useShapeJev } from '../../daemon/shape-measures-queries';
import { SettingRow, SettingsCard } from './setting-row';

export const SHAPE_JEV_LABEL = 'Send brainstorm messages to fast models';

/**
 * Shape spec §9: a project's opt-in for Jev's Shape decisions. Off by default; while off, Shape makes
 * no call at all for this project, shadow included.
 */
export function ShapeJevSetting({ project }: { readonly project: ProjectDto }) {
  const setting = useShapeJev(project.id);
  const set = useSetShapeJev(project.id);
  return (
    <SettingsCard>
      <SettingRow
        label={SHAPE_JEV_LABEL}
        description="Plan sends your brainstorm messages, not code, to OpenRouter and the model's provider, so a fast model can notice when you are ready to propose, state a decision, or ask a question for someone else. A brainstorm can hold a client's details; leave this off if that matters."
      >
        <Switch
          aria-label={SHAPE_JEV_LABEL}
          checked={setting.data?.enabled ?? false}
          disabled={setting.data === undefined || set.isPending}
          onChange={(event) => {
            set.mutate(event.currentTarget.checked);
          }}
        />
      </SettingRow>
    </SettingsCard>
  );
}

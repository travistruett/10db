import type { ProjectDto } from '@10db/contracts';
import { Anchor, Stack, Switch, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useJudgeStatus } from '../../daemon/judge-queries';
import { useSetShapeJev, useShapeJev } from '../../daemon/shape-measures-queries';
import { SettingsSectionKey } from './sections';
import { SettingRow, SettingsCard } from './setting-row';

export const SHAPE_JEV_LABEL = 'Send brainstorm messages to fast models';

/**
 * Shape spec §9: a project's opt-in for Jev's Shape decisions. Off by default; while off, Shape makes
 * no call at all for this project, shadow included.
 */
export function ShapeJevSetting({ project }: { readonly project: ProjectDto }) {
  const setting = useShapeJev(project.id);
  const set = useSetShapeJev(project.id);
  const judge = useJudgeStatus();
  const account = judge.data?.account ?? null;
  return (
    <SettingsCard>
      <SettingRow
        label={SHAPE_JEV_LABEL}
        description={
          account === null
            ? 'Sends your brainstorm messages, not code, to the account decisions run on, so a fast model can notice when you are ready to propose, state a decision, or ask a question for someone else.'
            : `Sends your brainstorm messages, not code, to the account decisions run on (OpenRouter · ${account.label}), so a fast model can notice when you are ready to propose, state a decision, or ask a question for someone else. A brainstorm can hold a client's details; leave this off if that matters.`
        }
      >
        <Stack gap={4} align="flex-end">
          <Switch
            aria-label={SHAPE_JEV_LABEL}
            checked={setting.data?.enabled ?? false}
            // A switch that is on can always be turned off; only turning it on needs an account.
            disabled={
              setting.data === undefined ||
              set.isPending ||
              (account === null && !setting.data.enabled)
            }
            onChange={(event) => {
              set.mutate(event.currentTarget.checked);
            }}
          />
          {judge.data !== undefined && account === null ? (
            <Text size="xs" c="dimmed">
              Pick an account for decisions first.{' '}
              <Anchor
                size="xs"
                renderRoot={(props) => (
                  <Link
                    {...props}
                    to="/settings/$section"
                    params={{ section: SettingsSectionKey.Decisions }}
                    search={{ focus: 'runs-on' }}
                  />
                )}
              >
                Open Decisions
              </Anchor>
            </Text>
          ) : null}
        </Stack>
      </SettingRow>
    </SettingsCard>
  );
}

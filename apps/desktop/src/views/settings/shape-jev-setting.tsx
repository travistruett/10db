import type { ProjectDto } from '@10db/contracts';
import { Alert, Button, Group, Stack, Switch, Text } from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { useJudgeStatus } from '../../daemon/judge-queries';
import { useSetShapeJev, useShapeJev } from '../../daemon/shape-measures-queries';
import { SettingsSectionKey } from './sections';
import { SettingRow } from './setting-row';

export const SHAPE_JEV_LABEL = 'Send Brainstorm Messages to Fast Models';

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
    <SettingRow
      label={SHAPE_JEV_LABEL}
      description="Sends brainstorm messages, not code, to a fast model."
      help={
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
      </Stack>
    </SettingRow>
  );
}

/** Above the planning card while no account runs decisions: the switch below stays off until one is picked. */
export function ShapeJevNeedsAccount() {
  const judge = useJudgeStatus();
  const navigate = useNavigate();
  if (judge.data?.account !== null) return null;
  return (
    <Alert variant="light" color="yellow" title="Decisions have no account yet">
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">
          Pick an account for decisions before sending brainstorm messages to a fast model.
        </Text>
        <Button
          size="xs"
          variant="default"
          style={{ flex: 'none' }}
          onClick={() => {
            void navigate({
              to: '/settings/$section',
              params: { section: SettingsSectionKey.Decisions },
              search: { focus: 'paid-by' },
            });
          }}
        >
          Open Decisions
        </Button>
      </Group>
    </Alert>
  );
}

import { WorkspaceMode } from '@10db/contracts';
import { SegmentedControl, Stack, TagsInput, Text } from '@mantine/core';

export interface WorkspaceFieldsProps {
  readonly workspaceMode: WorkspaceMode;
  readonly worktreeSeed: readonly string[];
  readonly errors?: { readonly workspaceMode?: string; readonly worktreeSeed?: string };
  readonly onChange: (change: {
    readonly workspaceMode?: WorkspaceMode;
    readonly worktreeSeed?: string[];
  }) => void;
}

/** Where a pull-request project's tasks work, and what a new worktree borrows from the main checkout. */
export function WorkspaceFields({
  workspaceMode,
  worktreeSeed,
  errors = {},
  onChange,
}: WorkspaceFieldsProps) {
  return (
    <>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Workspace
        </Text>
        <SegmentedControl
          aria-label="Workspace"
          value={workspaceMode}
          data={[
            { value: WorkspaceMode.Shared, label: 'Shared checkout' },
            { value: WorkspaceMode.Worktree, label: 'A worktree per task' },
          ]}
          onChange={(value) => {
            onChange({
              workspaceMode:
                value === WorkspaceMode.Worktree ? WorkspaceMode.Worktree : WorkspaceMode.Shared,
            });
          }}
        />
        {errors.workspaceMode ? (
          <Text size="xs" c="red">
            {errors.workspaceMode}
          </Text>
        ) : null}
      </Stack>
      {workspaceMode === WorkspaceMode.Worktree ? (
        <TagsInput
          label="Seed from the main checkout"
          description="Ignored directories cloned into each new worktree, by name"
          value={[...worktreeSeed]}
          error={errors.worktreeSeed}
          onChange={(worktreeSeed) => {
            onChange({ worktreeSeed });
          }}
        />
      ) : null}
    </>
  );
}

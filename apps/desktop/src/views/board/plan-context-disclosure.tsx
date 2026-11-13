import type { TaskId } from '@10db/contracts';
import { Box, Collapse, Group, List, Stack, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useId } from 'react';
import { useTaskPlanContext } from '../../daemon/plan-record-queries';
import { AnchorBadge } from '../shape/record/anchor-badge';
import { resultStatus } from '../shape/record/anchor-status';

// A task made from a Plan shows what its lane got of it: the block as it was packed, kept when the
// lane got it, so a re-import never changes what it says the lane read, and the checks of the anchors
// it cites.

export function PlanContextDisclosure({ taskId }: { readonly taskId: TaskId }) {
  const answer = useTaskPlanContext(taskId).data;
  const [opened, { toggle }] = useDisclosure(false);
  const bodyId = useId();
  const context = answer?.context ?? null;
  if (answer === undefined || context === null) return null;
  const Chevron = opened ? IconChevronDown : IconChevronRight;
  return (
    <Stack gap={4}>
      <UnstyledButton
        aria-expanded={opened}
        aria-controls={bodyId}
        onClick={toggle}
        style={{ alignSelf: 'flex-start' }}
      >
        <Group gap={4} wrap="nowrap">
          <Chevron size={14} stroke={1.5} aria-hidden="true" />
          <Text size="sm">{`Plan context · ${context.ref} · revision ${String(context.revision)}`}</Text>
        </Group>
      </UnstyledButton>
      <Collapse expanded={opened} id={bodyId}>
        <Stack gap="xs">
          {answer.packed === null ? (
            <Text size="sm" c="dimmed">
              Not sent yet
            </Text>
          ) : (
            <Box
              component="pre"
              // A region the keyboard can reach, since it scrolls.
              role="region"
              tabIndex={0}
              aria-label="What the lane got"
              m={0}
              p="xs"
              fz="xs"
              ff="monospace"
              mah={360}
              style={{
                whiteSpace: 'pre-wrap',
                overflowY: 'auto',
                background: 'var(--mantine-color-default)',
                borderRadius: 'var(--mantine-radius-md)',
              }}
            >
              {answer.packed.text}
            </Box>
          )}
          {answer.checks.length === 0 ? null : (
            <List size="sm" spacing={4} listStyleType="none">
              {answer.checks.map((check) => (
                <List.Item key={`${check.entryKey}:${String(check.anchorIndex)}`}>
                  <Group gap={6} wrap="nowrap">
                    <Text size="xs" ff="monospace">
                      {`${check.entryKey} · anchor ${String(check.anchorIndex + 1)}`}
                    </Text>
                    <AnchorBadge
                      status={resultStatus(check)}
                      // A check from another run than the one that got this block read another base.
                      note={
                        answer.packed !== null && check.workstreamId !== answer.packed.workstreamId
                          ? 'checked by an earlier run'
                          : null
                      }
                    />
                  </Group>
                </List.Item>
              ))}
            </List>
          )}
        </Stack>
      </Collapse>
    </Stack>
  );
}

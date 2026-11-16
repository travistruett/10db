import type { ConversationItemDto } from '@10db/contracts';
import { Box, Collapse, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import {
  IconChevronDown,
  IconChevronRight,
  IconCircle,
  IconCircleCheck,
} from '@tabler/icons-react';
import { useState } from 'react';

type PlanItem = Extract<ConversationItemDto, { kind: 'plan' }>;
export type TodoStep = PlanItem['steps'][number];

/** The agent's latest list: the last plan item of the transcript, which a later update replaces. */
export function latestTodos(items: readonly ConversationItemDto[]): readonly TodoStep[] {
  const plan = items.findLast((item): item is PlanItem => item.kind === 'plan');
  return plan?.steps ?? [];
}

function StepIcon({ status }: { readonly status: TodoStep['status'] }) {
  switch (status) {
    case 'completed':
      return <IconCircleCheck size={14} color="var(--mantine-color-teal-6)" aria-hidden />;
    case 'in_progress':
      return (
        <IconCircle size={14} color="var(--mantine-color-blue-5)" fill="currentColor" aria-hidden />
      );
    case 'pending':
      return <IconCircle size={14} color="var(--mantine-color-dimmed)" aria-hidden />;
  }
}

/**
 * The agent's todo list above the composer, as Claude Code shows it: each step with its status. It is
 * open while work remains and folds to its heading once every step is done.
 */
export function TodoList({ steps }: { readonly steps: readonly TodoStep[] }) {
  const done = steps.filter((s) => s.status === 'completed').length;
  const finished = steps.length > 0 && done === steps.length;
  const [picked, setPicked] = useState<boolean | null>(null);
  if (steps.length === 0) return null;
  const open = picked ?? !finished;
  return (
    <Box
      px="md"
      py={6}
      data-todo-list
      style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
    >
      <UnstyledButton
        aria-expanded={open}
        onClick={() => {
          setPicked(!open);
        }}
      >
        <Group gap={6} wrap="nowrap">
          {open ? (
            <IconChevronDown size={14} aria-hidden />
          ) : (
            <IconChevronRight size={14} aria-hidden />
          )}
          <Text size="xs" c="dimmed">
            Todos · {done} of {steps.length} done
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Stack gap={2} mt={4} component="ul" m={0} p={0} style={{ listStyle: 'none' }}>
          {steps.map((step, i) => (
            <Group
              key={`${String(i)}:${step.text}`}
              component="li"
              gap={8}
              wrap="nowrap"
              align="flex-start"
            >
              <Box pt={3}>
                <StepIcon status={step.status} />
              </Box>
              <Text
                size="sm"
                {...(step.status === 'completed' ? { c: 'dimmed', td: 'line-through' } : {})}
                {...(step.status === 'in_progress' ? { fw: 600 } : {})}
                aria-label={`${step.text}, ${step.status.replace('_', ' ')}`}
              >
                {step.text}
              </Text>
            </Group>
          ))}
        </Stack>
      </Collapse>
    </Box>
  );
}

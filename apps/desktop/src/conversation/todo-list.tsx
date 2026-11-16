import type { ConversationItemDto } from '@10db/contracts';
import { Box, Collapse, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import {
  IconChevronDown,
  IconChevronRight,
  IconCircle,
  IconCircleCheck,
  IconCircleDashed,
} from '@tabler/icons-react';
import { useState } from 'react';

type PlanItem = Extract<ConversationItemDto, { kind: 'plan' }>;
export type TodoStep = PlanItem['steps'][number];

/** The tallest the open list grows before it scrolls inside itself, so the transcript keeps its room. */
const LIST_MAX_HEIGHT = 'min(160px, 20vh)';

/** The agent's latest list: the last plan item of the transcript, which a later update replaces. */
export function latestTodos(items: readonly ConversationItemDto[]): readonly TodoStep[] {
  const plan = items.findLast((item): item is PlanItem => item.kind === 'plan');
  return plan?.steps ?? [];
}

/** A step as the row says it: an in-progress step of a turn that is over was interrupted. */
type Shown = TodoStep['status'] | 'interrupted';

function shownStatus(step: TodoStep, working: boolean): Shown {
  return step.status === 'in_progress' && !working ? 'interrupted' : step.status;
}

function StepIcon({ status }: { readonly status: Shown }) {
  switch (status) {
    case 'completed':
      return <IconCircleCheck size={14} color="var(--mantine-color-teal-6)" aria-hidden />;
    case 'in_progress':
      return (
        <IconCircle size={14} color="var(--mantine-color-blue-5)" fill="currentColor" aria-hidden />
      );
    case 'interrupted':
      return <IconCircleDashed size={14} color="var(--mantine-color-dimmed)" aria-hidden />;
    case 'pending':
      return <IconCircle size={14} color="var(--mantine-color-dimmed)" aria-hidden />;
  }
}

/** What identifies a list: its steps' texts, so a status change keeps the builder's fold and a new list does not. */
function signature(steps: readonly TodoStep[]): string {
  return JSON.stringify(steps.map((s) => s.text));
}

export interface TodoListProps {
  readonly steps: readonly TodoStep[];
  /** A turn is running: only then is a step "in progress". */
  readonly working: boolean;
  /** A card waits on the builder: the list starts folded, so the question keeps the room. */
  readonly cardWaiting?: boolean;
}

/**
 * The agent's plan just above the working line (sessions UI spec §7.5): one row, "Plan · 3 of 7 done ·
 * Now: …", open while work remains as Claude Code's list is and folded once every step is done. A
 * new list opens again.
 */
export function TodoList({ steps, working, cardWaiting = false }: TodoListProps) {
  const sig = signature(steps);
  const [picked, setPicked] = useState<{ readonly sig: string; readonly open: boolean } | null>(
    null,
  );
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.status === 'completed').length;
  const finished = done === steps.length;
  const open = picked?.sig === sig ? picked.open : !finished && !cardWaiting;
  const now = working ? steps.find((s) => s.status === 'in_progress') : undefined;
  return (
    <Box
      px="md"
      py={6}
      data-todo-list
      style={{ flex: 'none', borderTop: '1px solid var(--mantine-color-default-border)' }}
    >
      <UnstyledButton
        aria-expanded={open}
        w="100%"
        onClick={() => {
          setPicked({ sig, open: !open });
        }}
      >
        <Group gap={6} wrap="nowrap">
          {open ? (
            <IconChevronDown size={14} aria-hidden />
          ) : (
            <IconChevronRight size={14} aria-hidden />
          )}
          <Text size="xs" c="dimmed" truncate="end">
            Plan · {done} of {steps.length} done{now === undefined ? '' : ` · Now: ${now.text}`}
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Stack
          gap={2}
          mt={4}
          component="ul"
          m={0}
          p={0}
          style={{ listStyle: 'none', maxHeight: LIST_MAX_HEIGHT, overflowY: 'auto' }}
        >
          {steps.map((step, i) => {
            const status = shownStatus(step, working);
            return (
              <Group
                key={`${String(i)}:${step.text}`}
                component="li"
                gap={8}
                wrap="nowrap"
                align="flex-start"
              >
                <Box pt={3}>
                  <StepIcon status={status} />
                </Box>
                <Text
                  size="sm"
                  {...(status === 'completed' ? { c: 'dimmed', td: 'line-through' } : {})}
                  {...(status === 'in_progress' ? { fw: 600 } : {})}
                  aria-label={`${step.text}, ${status.replace('_', ' ')}`}
                >
                  {step.text}
                </Text>
              </Group>
            );
          })}
        </Stack>
      </Collapse>
    </Box>
  );
}

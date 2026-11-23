import type { KindDto } from '@10db/contracts';
import { ActionIcon, Group, Modal, Stack, Text } from '@mantine/core';
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react';
import { useMoveKind } from '../../daemon/kind-queries';

/**
 * The order of the kinds that override a step, which decides whose override wins when a task has several.
 * A kind with no override can never disagree with another, so it is not listed. A move puts the kind where its
 * neighbour among these sits, which keeps every other kind's place relative to the rest.
 */
export function TiebreakOrder({
  kinds,
  opened,
  onClose,
}: {
  /** Every kind, in position order. */
  readonly kinds: readonly KindDto[];
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  const move = useMoveKind();
  const overriding = kinds.filter((k) => Object.keys(k.overrides).length > 0);
  const moveTo = (kind: KindDto, neighbour: KindDto | undefined): void => {
    if (neighbour === undefined) return;
    move.mutate({ kindId: kind.id, position: kinds.findIndex((k) => k.id === neighbour.id) });
  };
  return (
    <Modal opened={opened} onClose={onClose} title="Tiebreak Order" size="sm">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          When a task has several of these kinds and their overrides disagree, the higher one wins.
        </Text>
        {overriding.length === 0 ? (
          <Text size="sm" c="dimmed">
            No kind has an override yet.
          </Text>
        ) : (
          <Stack gap={4} component="ol" m={0} p={0} style={{ listStyle: 'none' }}>
            {overriding.map((kind, index) => (
              <Group key={kind.id} component="li" justify="space-between" wrap="nowrap">
                <Text size="sm">{kind.label}</Text>
                <Group gap={2} wrap="nowrap">
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label={`Move ${kind.label} up`}
                    disabled={index === 0 || move.isPending}
                    onClick={() => {
                      moveTo(kind, overriding[index - 1]);
                    }}
                  >
                    <IconArrowUp size={14} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label={`Move ${kind.label} down`}
                    disabled={index === overriding.length - 1 || move.isPending}
                    onClick={() => {
                      moveTo(kind, overriding[index + 1]);
                    }}
                  >
                    <IconArrowDown size={14} />
                  </ActionIcon>
                </Group>
              </Group>
            ))}
          </Stack>
        )}
        {move.isError ? (
          <Text size="sm" c="red" role="alert">
            {move.error.message}
          </Text>
        ) : null}
      </Stack>
    </Modal>
  );
}

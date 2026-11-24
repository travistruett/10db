import { SendMode, contactIn, type PersonDto, type SlackMemberDto } from '@10db/contracts';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useSavePerson } from '../../../daemon/people';
import { MemberSelect } from '../people/member-select';
import { DEFAULT_DAILY_LIMIT } from '../people/person-modal';

/** The name a builder has until a Slack member's real name replaces it. */
const UNNAMED_BUILDER = 'You';

/**
 * Binds the builder to their own member in one workspace, so messages there name the builder. The first pick
 * (the builder still named "You") also renames the builder to the member's name; a later one keeps the name.
 * Optional: nothing waits on it.
 */
export function WhichIsYouModal({
  opened,
  builder,
  teamId,
  teamName,
  onClose,
}: {
  readonly opened: boolean;
  readonly builder: PersonDto;
  /** The workspace this one is for. */
  readonly teamId: string;
  readonly teamName: string;
  readonly onClose: () => void;
}) {
  const save = useSavePerson();
  const [picked, setPicked] = useState<SlackMemberDto | null>(null);
  const first = builder.name === UNNAMED_BUILDER;
  const close = () => {
    setPicked(null);
    save.reset();
    onClose();
  };
  return (
    <Modal opened={opened} onClose={close} title={`Who Are You in ${teamName}?`} centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Messages 10db sends in {teamName} carry your name.
        </Text>
        <MemberSelect
          ariaLabel={`You in ${teamName}`}
          placeholder={`Search ${teamName} by name, title or email`}
          value={picked}
          onPick={setPicked}
          teamId={teamId}
        />
        <Group justify="flex-end" gap="sm">
          {save.isError ? (
            <Text size="xs" c="red" style={{ flex: 1 }}>
              {save.error.message}
            </Text>
          ) : null}
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={picked === null}
            loading={save.isPending}
            onClick={() => {
              if (picked === null) return;
              const kept = contactIn(builder, teamId);
              const contact = {
                teamId,
                userId: picked.userId,
                sendMode: kept?.sendMode ?? SendMode.Review,
                dailyLimit: kept ? kept.dailyLimit : DEFAULT_DAILY_LIMIT,
              };
              save.mutate(
                {
                  id: builder.id,
                  input: {
                    handle: builder.handle,
                    name: first ? picked.realName : builder.name,
                    slack:
                      kept === null
                        ? [...builder.slack, contact]
                        : builder.slack.map((c) => (c.teamId === teamId ? contact : c)),
                  },
                },
                { onSuccess: close },
              );
            }}
          >
            That's Me
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

import { SendMode, contactIn, type PersonDto, type SlackMemberDto } from '@10db/contracts';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useSavePerson } from '../../../daemon/people';
import { MemberSelect } from '../people/member-select';
import { DEFAULT_DAILY_LIMIT } from '../people/person-modal';

/** The name a builder has until a Slack member's real name replaces it. */
const UNNAMED_BUILDER = 'You';

/**
 * Binds the builder to their own member in one workspace, so messages there name the builder. The first pick
 * (the builder still named "You") is a callout and renames the builder to the member's name; a later one is a
 * plain optional field and keeps the name; changing a pick is the same field with Cancel. Nothing waits on it.
 */
export function WhichIsYou({
  builder,
  teamId,
  changing,
  onDone,
}: {
  readonly builder: PersonDto;
  /** The workspace this one is for. */
  readonly teamId: string;
  /** The builder has a member here already and chose Change Who You Are. */
  readonly changing: boolean;
  readonly onDone: () => void;
}) {
  const save = useSavePerson();
  const [picked, setPicked] = useState<SlackMemberDto | null>(null);
  const first = builder.name === UNNAMED_BUILDER;
  const form = (
    <Stack gap="xs">
      <Group align="flex-end" gap="sm" wrap="nowrap">
        <div style={{ flex: 1 }}>
          <MemberSelect
            label="Which One Is You?"
            value={picked}
            onPick={setPicked}
            teamId={teamId}
          />
        </div>
        {changing ? (
          <Button variant="default" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
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
              { onSuccess: onDone },
            );
          }}
        >
          That's Me
        </Button>
      </Group>
      {!changing && !first ? (
        <Text size="xs" c="dimmed">
          Optional
        </Text>
      ) : null}
      {save.isError ? (
        <Text size="xs" c="red">
          {save.error.message}
        </Text>
      ) : null}
    </Stack>
  );
  if (changing || !first) return form;
  return (
    <Alert color="yellow" variant="light" p="sm">
      <Stack gap="xs">
        <Text size="sm">Pick yourself so messages carry your name.</Text>
        {form}
      </Stack>
    </Alert>
  );
}

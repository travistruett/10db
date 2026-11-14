import { SendMode, type PersonDto, type SlackMemberDto } from '@10db/contracts';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useSavePerson } from '../../../daemon/people';
import { MemberSelect } from '../people/member-select';
import { DEFAULT_DAILY_LIMIT } from '../people/person-modal';

/**
 * Binds the builder to their own Slack member; messages name the builder, so connecting is unfinished
 * until this is done, and the member's name becomes the builder's. A first pick is a callout to finish
 * setup; changing it later is the same field, plainly, with Cancel.
 */
export function WhichIsYou({
  builder,
  changing,
  onDone,
}: {
  readonly builder: PersonDto;
  /** The builder has a member already and chose Change Who You Are. */
  readonly changing: boolean;
  readonly onDone: () => void;
}) {
  const save = useSavePerson();
  const [picked, setPicked] = useState<SlackMemberDto | null>(null);
  const form = (
    <Stack gap="xs">
      <Group align="flex-end" gap="sm" wrap="nowrap">
        <div style={{ flex: 1 }}>
          <MemberSelect label="Which one is you?" value={picked} onPick={setPicked} />
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
            save.mutate(
              {
                id: builder.id,
                input: {
                  handle: builder.handle,
                  name: picked.realName,
                  slack: {
                    teamId: picked.teamId,
                    userId: picked.userId,
                    sendMode: builder.slack?.sendMode ?? SendMode.Review,
                    dailyLimit: builder.slack ? builder.slack.dailyLimit : DEFAULT_DAILY_LIMIT,
                  },
                },
              },
              { onSuccess: onDone },
            );
          }}
        >
          That's Me
        </Button>
      </Group>
      {save.isError ? (
        <Text size="xs" c="red">
          {save.error.message}
        </Text>
      ) : null}
    </Stack>
  );
  if (changing) return form;
  return (
    <Alert color="yellow" variant="light" p="sm">
      <Stack gap="xs">
        <Text size="sm">
          Finish setup: pick yourself so messages carry your name. Until then, none can be sent.
        </Text>
        {form}
      </Stack>
    </Alert>
  );
}

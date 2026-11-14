import { SendMode, type PersonDto, type PersonInput, type SlackMemberDto } from '@10db/contracts';
import {
  Anchor,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Radio,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { useSavePerson, useSlackConnection, useSlackMember } from '../../../daemon/people';
import { FormModal } from '../../../shell/form-modal';
import { MemberSelect } from './member-select';
import { uniqueHandle } from './person-handle';

export const DEFAULT_DAILY_LIMIT = 10;

interface FormState {
  /** Added by name: someone 10db can't message, whose questions the builder passes on. */
  readonly byName: boolean;
  /** The member picked in this form; null keeps the one the person has. */
  readonly member: SlackMemberDto | null;
  readonly name: string;
  readonly sendMode: SendMode;
  readonly dailyLimit: number | null;
}

function initial(person: PersonDto | null, slackReady: boolean): FormState {
  return {
    byName: person === null ? !slackReady : !person.isBuilder && person.slack === null,
    member: null,
    name: person?.name ?? '',
    sendMode: person?.slack?.sendMode ?? SendMode.Review,
    dailyLimit: person?.slack ? person.slack.dailyLimit : DEFAULT_DAILY_LIMIT,
  };
}

/**
 * Adds a person, or edits one, in the order the builder decides: who they are, how 10db asks them,
 * and how many new questions a day. The handle is made from the name and never shown.
 */
export function PersonModal({
  person,
  people,
  opened,
  onClose,
}: {
  readonly person: PersonDto | null;
  readonly people: readonly PersonDto[];
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  // Remounted per person, so a form never carries the last one's fields.
  return opened ? (
    <PersonForm key={person?.id ?? 'new'} person={person} people={people} onClose={onClose} />
  ) : null;
}

function PersonForm({
  person,
  people,
  onClose,
}: {
  readonly person: PersonDto | null;
  readonly people: readonly PersonDto[];
  readonly onClose: () => void;
}) {
  const save = useSavePerson();
  const connection = useSlackConnection();
  const slackReady = connection.data?.state === 'connected';
  const team = connection.data?.teamName ?? 'Slack';
  const current = useSlackMember(person?.slack?.userId ?? null);
  const [form, setForm] = useState<FormState>(() => initial(person, slackReady));
  const set = (change: Partial<FormState>): void => {
    setForm((was) => ({ ...was, ...change }));
  };
  const isBuilder = person?.isBuilder === true;
  const kept = person?.slack ?? null;
  const member = form.member ?? current;
  // Someone in Slack needs a member; the builder may have none yet.
  const reachable = form.byName || form.member !== null || kept !== null || isBuilder;
  const showName = form.byName || isBuilder || form.member !== null || kept !== null;
  const askedInSlack = !form.byName && !isBuilder;
  const valid = form.name.trim() !== '' && reachable;

  const submit = (): void => {
    const picked = form.member;
    const contact =
      form.byName || (picked === null && kept === null)
        ? null
        : {
            teamId: picked?.teamId ?? kept?.teamId ?? '',
            userId: picked?.userId ?? kept?.userId ?? '',
            sendMode: form.sendMode,
            dailyLimit: form.dailyLimit,
          };
    const taken = new Set(people.filter((p) => p.id !== person?.id).map((p) => p.handle));
    const input: PersonInput = {
      handle: person?.handle ?? uniqueHandle(form.name, taken),
      name: form.name.trim(),
      slack: contact,
    };
    save.mutate({ id: person?.id ?? null, input }, { onSuccess: onClose });
  };

  return (
    <FormModal
      opened
      onClose={onClose}
      title={person ? `Edit ${person.name}` : 'Add Person'}
      size="md"
      error={save.isError ? save.error.message : null}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={submit}>
            Save Person
          </Button>
        </>
      }
    >
      <Stack gap="lg">
        <Stack gap="xs">
          {!form.byName && slackReady ? (
            <MemberSelect
              label={isBuilder ? 'Which one is you?' : `Find someone in ${team}`}
              value={member}
              onPick={(picked) => {
                set({ member: picked, ...(picked === null ? {} : { name: picked.realName }) });
              }}
            />
          ) : null}
          {!form.byName && !isBuilder && slackReady ? (
            <Anchor
              component="button"
              type="button"
              size="sm"
              c="dimmed"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                set({ byName: true, member: null });
              }}
            >
              Not on Slack? Add them by name
            </Anchor>
          ) : null}
          {showName ? (
            <TextInput
              label="Name"
              value={form.name}
              onChange={(event) => {
                set({ name: event.currentTarget.value });
              }}
            />
          ) : null}
          {form.byName ? (
            <Text size="sm" c="dimmed">
              10db can't message them. Their questions come to you, ready to copy, and you answer
              for them.
            </Text>
          ) : null}
          {form.byName && slackReady ? (
            <Anchor
              component="button"
              type="button"
              size="sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                set({ byName: false });
              }}
            >
              Find them in Slack instead
            </Anchor>
          ) : null}
        </Stack>
        {askedInSlack ? (
          <Radio.Group
            label="Before 10db messages them"
            description="The first message is always shown to you."
            value={form.sendMode}
            onChange={(value) => {
              set({ sendMode: value === SendMode.Auto ? SendMode.Auto : SendMode.Review });
            }}
          >
            <Stack gap="xs" mt="xs">
              <Radio value={SendMode.Review} label="Show me each message first" />
              <Radio value={SendMode.Auto} label="Send on its own" />
            </Stack>
          </Radio.Group>
        ) : null}
        {askedInSlack ? (
          <Stack gap={4}>
            <Group gap="xs" wrap="nowrap">
              <Text size="sm">Up to</Text>
              <NumberInput
                aria-label="New questions a day"
                w={80}
                min={1}
                max={100}
                allowDecimal={false}
                disabled={form.dailyLimit === null}
                value={form.dailyLimit ?? DEFAULT_DAILY_LIMIT}
                onChange={(value) => {
                  if (typeof value === 'number') set({ dailyLimit: value });
                }}
              />
              <Text size="sm">new questions a day</Text>
              <Checkbox
                ml="md"
                label="No limit"
                checked={form.dailyLimit === null}
                onChange={(event) => {
                  set({ dailyLimit: event.currentTarget.checked ? null : DEFAULT_DAILY_LIMIT });
                }}
              />
            </Group>
            <Text size="xs" c="dimmed">
              Replies in an existing thread don't count.
            </Text>
          </Stack>
        ) : null}
      </Stack>
    </FormModal>
  );
}

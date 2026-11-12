import { SendMode, type PersonDto, type PersonInput, type SlackMemberDto } from '@10db/contracts';
import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Radio,
  SegmentedControl,
  Stack,
  Switch,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { useSavePerson, useSlackConnection } from '../../../daemon/people';
import { MemberSelect } from './member-select';

export const DEFAULT_DAILY_LIMIT = 10;

/** A handle proposed from a name: lowercase words joined by hyphens, starting with a letter. */
export function proposeHandle(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (/^[a-z]/.test(slug) ? slug : `p-${slug}`).slice(0, 40).replace(/-+$/, '');
}

interface FormState {
  readonly inSlack: boolean;
  readonly member: SlackMemberDto | null;
  readonly name: string;
  readonly handle: string;
  readonly handleEdited: boolean;
  readonly sendMode: SendMode;
  readonly dailyLimit: number | null;
}

function initial(person: PersonDto | null): FormState {
  return {
    inSlack: person?.isBuilder === true || person?.slack !== null,
    member: null,
    name: person?.name ?? '',
    handle: person?.handle ?? '',
    handleEdited: person !== null,
    sendMode: person?.slack?.sendMode ?? SendMode.Review,
    dailyLimit: person?.slack ? person.slack.dailyLimit : DEFAULT_DAILY_LIMIT,
  };
}

/** Adds a person, or edits one: who they are in Slack, how questions reach them and how many a day. */
export function PersonModal({
  person,
  opened,
  onClose,
}: {
  readonly person: PersonDto | null;
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={person ? `Edit ${person.name}` : 'Add Person'}
      size="lg"
    >
      {/* Remounted per person, so a form never carries the last one's fields. */}
      <PersonForm key={person?.id ?? 'new'} person={person} onClose={onClose} />
    </Modal>
  );
}

function PersonForm({
  person,
  onClose,
}: {
  readonly person: PersonDto | null;
  readonly onClose: () => void;
}) {
  const save = useSavePerson();
  const connection = useSlackConnection();
  const [form, setForm] = useState<FormState>(() => initial(person));
  const set = (change: Partial<FormState>): void => {
    setForm((current) => ({ ...current, ...change }));
  };
  const slackReady = connection.data?.state === 'connected';
  const slack = person?.slack ?? null;
  // Editing keeps the contact's member; adding needs one picked.
  const hasContact = form.inSlack && (form.member !== null || slack !== null);
  // The builder may have no Slack member yet; everyone else in Slack needs one.
  const valid =
    form.name.trim() !== '' &&
    form.handle !== '' &&
    (!form.inSlack || hasContact || person?.isBuilder === true);

  const submit = (): void => {
    const contact =
      !form.inSlack || !hasContact
        ? null
        : {
            teamId: form.member?.teamId ?? slack?.teamId ?? '',
            userId: form.member?.userId ?? slack?.userId ?? '',
            sendMode: form.sendMode,
            dailyLimit: form.dailyLimit,
          };
    const input: PersonInput = { handle: form.handle, name: form.name.trim(), slack: contact };
    save.mutate({ id: person?.id ?? null, input }, { onSuccess: onClose });
  };

  return (
    <Stack>
      {person?.isBuilder ? null : (
        <Radio.Group
          value={form.inSlack ? 'slack' : 'none'}
          onChange={(value) => {
            set({ inSlack: value === 'slack' });
          }}
        >
          <Group>
            <Radio
              value="slack"
              label="A member of your workspace"
              disabled={!slackReady && person === null}
            />
            <Radio value="none" label="Someone not in Slack" />
          </Group>
        </Radio.Group>
      )}
      {person?.isBuilder ? null : !slackReady && person === null && form.inSlack ? (
        <Alert color="yellow" variant="light">
          Connect Slack first to pick a member, or add someone not in Slack.
        </Alert>
      ) : null}
      {form.inSlack && (slackReady || !person?.isBuilder) ? (
        <MemberSelect
          value={form.member}
          onPick={(member) => {
            set({
              member,
              ...(member === null
                ? {}
                : {
                    name: member.realName,
                    ...(form.handleEdited ? {} : { handle: proposeHandle(member.realName) }),
                  }),
            });
          }}
        />
      ) : null}
      <TextInput
        label="Name"
        value={form.name}
        onChange={(event) => {
          const name = event.currentTarget.value;
          set({ name, ...(form.handleEdited ? {} : { handle: proposeHandle(name) }) });
        }}
      />
      <TextInput
        label="Handle"
        description="How rules and cards name them: lowercase letters, digits and hyphens."
        value={form.handle}
        onChange={(event) => {
          set({ handle: event.currentTarget.value, handleEdited: true });
        }}
      />
      {form.inSlack && !person?.isBuilder ? (
        <>
          <SegmentedControl
            aria-label="Send mode"
            value={form.sendMode}
            onChange={(value) => {
              set({ sendMode: value === SendMode.Auto ? SendMode.Auto : SendMode.Review });
            }}
            data={[
              { value: SendMode.Review, label: 'Review Each' },
              { value: SendMode.Auto, label: 'Send Without Asking' },
            ]}
          />
          <Group align="flex-end" gap="md">
            <NumberInput
              label="New questions a day"
              description="Counts only a new question that starts a thread. Replies, follow-ups and the conversation in a thread never count."
              min={1}
              max={100}
              disabled={form.dailyLimit === null}
              value={form.dailyLimit ?? DEFAULT_DAILY_LIMIT}
              onChange={(value) => {
                if (typeof value === 'number') set({ dailyLimit: value });
              }}
              style={{ flex: 1 }}
            />
            <Switch
              aria-label="No limit"
              label="No limit"
              checked={form.dailyLimit === null}
              onChange={(event) => {
                set({ dailyLimit: event.currentTarget.checked ? null : DEFAULT_DAILY_LIMIT });
              }}
            />
          </Group>
        </>
      ) : null}
      {save.isError ? (
        <Alert color="red" variant="light">
          {save.error.message}
        </Alert>
      ) : null}
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!valid} loading={save.isPending} onClick={submit}>
          Save Person
        </Button>
      </Group>
    </Stack>
  );
}

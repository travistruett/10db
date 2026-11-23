import {
  SendMode,
  type PersonDto,
  type PersonInput,
  type SlackContactInput,
  type SlackMemberDto,
} from '@10db/contracts';
import {
  Anchor,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Paper,
  Radio,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { useSavePerson, useSlackMember, useSlackStatus } from '../../../daemon/people';
import { FormModal } from '../../../shell/form-modal';
import { MemberSelect } from './member-select';
import { uniqueHandle } from './person-handle';

export const DEFAULT_DAILY_LIMIT = 10;

/** One workspace's contact as the form holds it. */
interface ContactForm {
  readonly teamId: string;
  /** The member the contact is for; null for a block added and not yet picked. */
  readonly member: SlackMemberDto | null;
  readonly userId: string | null;
  readonly sendMode: SendMode;
  readonly dailyLimit: number | null;
}

interface FormState {
  /** Added by name: someone 10db can't message, whose questions the builder passes on. */
  readonly byName: boolean;
  readonly name: string;
  /** Whether the builder typed the name, so a picked member stops proposing one. */
  readonly nameEdited: boolean;
  readonly contacts: readonly ContactForm[];
}

const blankContact = (teamId: string): ContactForm => ({
  teamId,
  member: null,
  userId: null,
  sendMode: SendMode.Review,
  dailyLimit: DEFAULT_DAILY_LIMIT,
});

function initial(person: PersonDto | null, firstTeam: string | null): FormState {
  if (person === null)
    return {
      byName: firstTeam === null,
      name: '',
      nameEdited: false,
      contacts: firstTeam === null ? [] : [blankContact(firstTeam)],
    };
  return {
    byName: !person.isBuilder && person.slack.length === 0,
    name: person.name,
    nameEdited: true,
    contacts: person.slack.map((c) => ({
      teamId: c.teamId,
      member: null,
      userId: c.userId,
      sendMode: c.sendMode,
      dailyLimit: c.dailyLimit,
    })),
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
  const status = useSlackStatus();
  // Signed in is any listed workspace, whatever its state; picking someone in one that is down shows why.
  const workspaces = status.data?.workspaces ?? [];
  const connected = workspaces.filter((w) => w.state === 'connected');
  const [form, setForm] = useState<FormState>(() =>
    initial(person, connected.at(0)?.teamId ?? null),
  );
  const set = (change: Partial<FormState>): void => {
    setForm((was) => ({ ...was, ...change }));
  };
  const change = (teamId: string, next: Partial<ContactForm>): void => {
    setForm((was) => ({
      ...was,
      contacts: was.contacts.map((c) => (c.teamId === teamId ? { ...c, ...next } : c)),
    }));
  };
  const isBuilder = person?.isBuilder === true;
  const slackReady = connected.length > 0;
  const picked = form.contacts.filter((c) => c.userId !== null);
  // Someone in Slack needs a member; the builder may have none yet.
  const reachable = form.byName || picked.length > 0 || isBuilder;
  const showName = form.byName || isBuilder || picked.length > 0;
  const askedInSlack = !form.byName && !isBuilder;
  const valid = form.name.trim() !== '' && reachable;
  const addable = workspaces.filter((w) => !form.contacts.some((c) => c.teamId === w.teamId));

  const submit = (): void => {
    // The whole list goes: a contact in a workspace that isn't signed in stays unless removed.
    const slack: SlackContactInput[] = form.byName
      ? []
      : picked.map((c) => ({
          teamId: c.teamId,
          userId: c.userId ?? '',
          sendMode: c.sendMode,
          dailyLimit: c.dailyLimit,
        }));
    const taken = new Set(people.filter((p) => p.id !== person?.id).map((p) => p.handle));
    const input: PersonInput = {
      handle: person?.handle ?? uniqueHandle(form.name, taken),
      name: form.name.trim(),
      slack,
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
          {showName ? (
            <TextInput
              label="Name"
              value={form.name}
              onChange={(event) => {
                set({ name: event.currentTarget.value, nameEdited: true });
              }}
            />
          ) : null}
          {form.byName ? (
            <Text size="sm" c="dimmed">
              10db can't message them. Their questions come to you, ready to copy, and you answer
              for them.
            </Text>
          ) : null}
          {!form.byName && person === null && slackReady ? (
            <Anchor
              component="button"
              type="button"
              size="sm"
              c="dimmed"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                set({ byName: true });
              }}
            >
              Not on Slack? Add Them by Name
            </Anchor>
          ) : null}
          {form.byName && slackReady ? (
            <Anchor
              component="button"
              type="button"
              size="sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                set({
                  byName: false,
                  contacts:
                    form.contacts.length > 0
                      ? form.contacts
                      : [blankContact(connected[0]?.teamId ?? '')],
                });
              }}
            >
              Find them in Slack instead
            </Anchor>
          ) : null}
        </Stack>
        {form.byName
          ? null
          : form.contacts.map((contact) => (
              <ContactBlock
                key={contact.teamId}
                contact={contact}
                teamName={workspaces.find((w) => w.teamId === contact.teamId)?.teamName ?? null}
                signedIn={workspaces.some((w) => w.teamId === contact.teamId)}
                isBuilder={isBuilder}
                askedInSlack={askedInSlack}
                onChange={(next) => {
                  change(contact.teamId, next);
                  if (next.member !== undefined && next.member !== null && !form.nameEdited)
                    set({ name: next.member.realName });
                }}
                onRemove={() => {
                  set({ contacts: form.contacts.filter((c) => c.teamId !== contact.teamId) });
                }}
              />
            ))}
        {form.byName
          ? null
          : addable.map((w) => (
              <Anchor
                key={w.teamId}
                component="button"
                type="button"
                size="sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => {
                  set({ contacts: [...form.contacts, blankContact(w.teamId)] });
                }}
              >
                {`Add ${w.teamName}`}
              </Anchor>
            ))}
      </Stack>
    </FormModal>
  );
}

/** One workspace's contact: who they are there, how 10db asks them and how many questions a day. */
function ContactBlock({
  contact,
  teamName,
  signedIn,
  isBuilder,
  askedInSlack,
  onChange,
  onRemove,
}: {
  readonly contact: ContactForm;
  readonly teamName: string | null;
  readonly signedIn: boolean;
  readonly isBuilder: boolean;
  readonly askedInSlack: boolean;
  readonly onChange: (next: Partial<ContactForm>) => void;
  readonly onRemove: () => void;
}) {
  const current = useSlackMember(contact.teamId, contact.userId);
  const name = teamName ?? 'A workspace that is no longer signed in';
  if (!signedIn)
    return (
      <Paper withBorder p="sm" radius="md" style={{ opacity: 0.6 }}>
        <Group justify="space-between" wrap="nowrap">
          <Text size="sm">{name} · not connected</Text>
          <Button size="xs" variant="subtle" color="red" onClick={onRemove}>
            {`Remove ${name} contact`}
          </Button>
        </Group>
      </Paper>
    );
  return (
    <Paper withBorder p="sm" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Text size="sm" fw={600}>
            {name}
          </Text>
          <Button size="xs" variant="subtle" color="red" onClick={onRemove}>
            {`Remove ${name} contact`}
          </Button>
        </Group>
        <MemberSelect
          teamId={contact.teamId}
          label={isBuilder ? 'Which one is you?' : `Find someone in ${name}`}
          value={contact.member ?? current}
          onPick={(picked) => {
            onChange({ member: picked, userId: picked?.userId ?? null });
          }}
        />
        {askedInSlack ? (
          <Radio.Group
            label="Before 10db Messages Them"
            description="The first message is always shown to you."
            value={contact.sendMode}
            onChange={(value) => {
              onChange({ sendMode: value === SendMode.Auto ? SendMode.Auto : SendMode.Review });
            }}
          >
            <Stack gap="xs" mt="xs">
              <Radio value={SendMode.Review} label="Show Me Each Message First" />
              <Radio value={SendMode.Auto} label="Send on Its Own" />
            </Stack>
          </Radio.Group>
        ) : null}
        {askedInSlack ? (
          <Stack gap={4}>
            <Group gap="xs" wrap="nowrap">
              <Text size="sm">Up to</Text>
              <NumberInput
                aria-label={`New questions a day in ${name}`}
                w={80}
                min={1}
                max={100}
                allowDecimal={false}
                disabled={contact.dailyLimit === null}
                value={contact.dailyLimit ?? DEFAULT_DAILY_LIMIT}
                onChange={(value) => {
                  if (typeof value === 'number') onChange({ dailyLimit: value });
                }}
              />
              <Text size="sm">new questions a day</Text>
              <Checkbox
                ml="md"
                label="No Limit"
                checked={contact.dailyLimit === null}
                onChange={(event) => {
                  onChange({
                    dailyLimit: event.currentTarget.checked ? null : DEFAULT_DAILY_LIMIT,
                  });
                }}
              />
            </Group>
            <Text size="xs" c="dimmed">
              Replies in an existing thread don't count.
            </Text>
          </Stack>
        ) : null}
      </Stack>
    </Paper>
  );
}

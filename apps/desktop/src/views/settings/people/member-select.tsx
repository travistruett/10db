import type { SlackMemberDto } from '@10db/contracts';
import { Avatar, Group, Select, Text, type ComboboxItem } from '@mantine/core';
import { useState } from 'react';
import { useSlackMembers } from '../../../daemon/people';

function describe(member: SlackMemberDto): string {
  return [member.realName, member.title].filter((part) => part !== null && part !== '').join(' · ');
}

/** The workspace's members, searched by name, title or email. Slack's refusal shows beside the field. */
export function MemberSelect({
  value,
  onPick,
}: {
  readonly value: SlackMemberDto | null;
  readonly onPick: (member: SlackMemberDto | null) => void;
}) {
  const [query, setQuery] = useState('');
  const members = useSlackMembers(query, true);
  const list = members.data ?? [];
  const data: ComboboxItem[] = list.map((m) => ({ value: m.userId, label: describe(m) }));
  if (value !== null && !list.some((m) => m.userId === value.userId))
    data.push({ value: value.userId, label: describe(value) });
  return (
    <Select
      label="Slack member"
      placeholder="Search the workspace"
      searchable
      clearable
      data={data}
      value={value?.userId ?? null}
      searchValue={query}
      onSearchChange={setQuery}
      filter={({ options }) => options}
      nothingFoundMessage={
        members.isPending
          ? 'Searching…'
          : "No members found. Is the app installed in this person's workspace?"
      }
      error={members.isError ? members.error.message : undefined}
      onChange={(userId) => {
        onPick(list.find((m) => m.userId === userId) ?? null);
      }}
      renderOption={({ option }) => {
        const member = list.find((m) => m.userId === option.value);
        return (
          <Group gap="sm" wrap="nowrap">
            <Avatar src={member?.avatarUrl ?? null} size="sm" radius="xl" />
            <div>
              <Text size="sm">{option.label}</Text>
              {member?.email ? (
                <Text size="xs" c="dimmed">
                  {member.email}
                </Text>
              ) : null}
            </div>
          </Group>
        );
      }}
    />
  );
}

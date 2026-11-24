import { AreaRole, pageLabel } from '@10db/contracts';
import { Group, Input, SegmentedControl, Stack, TextInput } from '@mantine/core';
import type { RoleChoice } from './area-role-fields';

const KINDS = [
  { value: '', label: 'Other' },
  { value: AreaRole.Page, label: 'Page' },
  { value: AreaRole.Shared, label: 'Shared' },
];

/** What the chosen kind means, under the choice. */
const MEANING: Record<RoleChoice, string> = {
  '': 'A part of the project, such as a backend app or a package.',
  [AreaRole.Page]:
    'A screen of the app, held by one task while it works on it. Two pages never share a file.',
  [AreaRole.Shared]:
    'Code many pages use, such as components or styles. A file a page also matches is the page’s.',
};

const isRoleChoice = (value: string): value is RoleChoice =>
  value === '' || value === AreaRole.Page || value === AreaRole.Shared;

/** An area's kind, as the table's Kind column shows it, and a page's route and label. */
export function AreaKindField({
  name,
  role,
  route,
  label,
  onChange,
}: {
  readonly name: string;
  readonly role: RoleChoice;
  readonly route: string;
  readonly label: string;
  readonly onChange: (next: {
    readonly role?: RoleChoice;
    readonly route?: string;
    readonly label?: string;
  }) => void;
}) {
  return (
    <Stack gap="sm">
      <Input.Wrapper label="Kind" description={MEANING[role]}>
        <SegmentedControl
          mt={6}
          aria-label="Area kind"
          data={KINDS}
          value={role}
          onChange={(value) => {
            if (isRoleChoice(value)) onChange({ role: value });
          }}
        />
      </Input.Wrapper>
      {role === AreaRole.Page ? (
        <Group grow align="flex-start" gap="sm">
          <TextInput
            label="Route"
            aria-label="Area route"
            placeholder="/people"
            description="Optional"
            value={route}
            onChange={(e) => {
              onChange({ route: e.currentTarget.value });
            }}
          />
          <TextInput
            label="Label"
            aria-label="Area label"
            description="What the Workbench calls it"
            placeholder={pageLabel({ name: name.trim() })}
            maxLength={40}
            value={label}
            onChange={(e) => {
              onChange({ label: e.currentTarget.value });
            }}
          />
        </Group>
      ) : null}
    </Stack>
  );
}

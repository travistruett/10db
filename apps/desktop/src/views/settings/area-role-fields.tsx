import { AreaRole } from '@10db/contracts';
import { NativeSelect, Stack, Text, TextInput } from '@mantine/core';

/** An area's role as a select holds it: empty for an area with none. */
export type RoleChoice = AreaRole | '';

const ROLE_OPTIONS = [
  { value: '', label: 'No role' },
  { value: AreaRole.Page, label: 'Page' },
  { value: AreaRole.Shared, label: 'Shared' },
];

const WHAT_IT_MEANS: Record<RoleChoice, string> = {
  '': 'No role: the area works as it always has.',
  [AreaRole.Page]:
    'A page: a screen of the app, held by one task while it works on it. Two pages may not share a file.',
  [AreaRole.Shared]:
    'Shared: code many pages use, such as components, styles or public files. A file a page also matches is the page’s.',
};

const isRoleChoice = (value: string): value is RoleChoice =>
  value === '' || value === AreaRole.Page || value === AreaRole.Shared;

/** The role and route fields of an area draft, as a stored area carries them. */
export function roleFields(role: RoleChoice, route: string): { role?: AreaRole; route?: string } {
  if (role === '') return {};
  const trimmed = route.trim();
  return role === AreaRole.Page && trimmed !== '' ? { role, route: trimmed } : { role };
}

/** Choose whether an area is a page or shared, and the route of a page. */
export function AreaRoleFields({
  index,
  role,
  route,
  onChange,
}: {
  /** The area's place in the list, from 1, which names the fields. */
  readonly index: number;
  readonly role: RoleChoice;
  readonly route: string;
  readonly onChange: (next: { readonly role?: RoleChoice; readonly route?: string }) => void;
}) {
  const n = String(index);
  return (
    <Stack gap={4}>
      <NativeSelect
        size="xs"
        aria-label={`Area ${n} role`}
        data={ROLE_OPTIONS}
        value={role}
        w={140}
        onChange={(e) => {
          const value = e.currentTarget.value;
          if (isRoleChoice(value)) onChange({ role: value });
        }}
      />
      {role === AreaRole.Page ? (
        <TextInput
          size="xs"
          aria-label={`Area ${n} route`}
          placeholder="/people"
          description="The path in the app that shows this page. Leave it empty when no single path does."
          value={route}
          onChange={(e) => {
            onChange({ route: e.currentTarget.value });
          }}
        />
      ) : null}
      <Text size="xs" c="dimmed">
        {WHAT_IT_MEANS[role]}
      </Text>
    </Stack>
  );
}

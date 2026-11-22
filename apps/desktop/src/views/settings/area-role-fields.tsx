import { AreaRole, pageLabel } from '@10db/contracts';
import { NativeSelect, Stack, Text, TextInput } from '@mantine/core';

/** An area's role as a select holds it: empty for an area with none. */
export type RoleChoice = AreaRole | '';

const ROLE_OPTIONS = [
  { value: '', label: 'No Role' },
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

/**
 * The role, route and label fields of an area draft, as a stored area carries them: a route and a
 * label only on a page, and an empty one as none.
 */
export function roleFields(
  role: RoleChoice,
  route: string,
  label = '',
): { role?: AreaRole; route?: string; label?: string } {
  if (role === '') return {};
  if (role !== AreaRole.Page) return { role };
  const trimmedRoute = route.trim();
  const trimmedLabel = label.trim();
  return {
    role,
    ...(trimmedRoute === '' ? {} : { route: trimmedRoute }),
    ...(trimmedLabel === '' ? {} : { label: trimmedLabel }),
  };
}

/** Choose whether an area is a page or shared, and the route of a page. */
export function AreaRoleFields({
  index,
  name,
  role,
  route,
  label,
  onChange,
}: {
  /** The area's place in the list, from 1, which names the fields. */
  readonly index: number;
  readonly role: RoleChoice;
  readonly route: string;
  /** The area's name, whose capitalised form is the label's placeholder. */
  readonly name?: string;
  /** A page's label; the field shows only when this is given. */
  readonly label?: string;
  readonly onChange: (next: {
    readonly role?: RoleChoice;
    readonly route?: string;
    readonly label?: string;
  }) => void;
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
      {role === AreaRole.Page && label !== undefined ? (
        <TextInput
          size="xs"
          aria-label={`Area ${n} label`}
          placeholder={pageLabel({ name: name?.trim() ?? '' })}
          description="What the page is called where you read it. Leave it empty to use its name."
          maxLength={40}
          value={label}
          onChange={(e) => {
            onChange({ label: e.currentTarget.value });
          }}
        />
      ) : null}
      <Text size="xs" c="dimmed">
        {WHAT_IT_MEANS[role]}
      </Text>
    </Stack>
  );
}

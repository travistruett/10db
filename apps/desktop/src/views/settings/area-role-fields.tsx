import { AreaRole, pageLabel } from '@10db/contracts';
import { Group, NativeSelect, Text, TextInput } from '@mantine/core';
import { HelpTip } from './help-tip';

/** An area's role as a select holds it: empty for an area with none. */
export type RoleChoice = AreaRole | '';

const ROLE_OPTIONS = [
  { value: '', label: 'No Role' },
  { value: AreaRole.Page, label: 'Page' },
  { value: AreaRole.Shared, label: 'Shared' },
];

/** What each role means; shown once, beside the Role label, not under every area. */
export function RoleHelp() {
  return (
    <HelpTip label="Role">
      <Text size="sm" mb={4}>
        No Role: the area works as it always has.
      </Text>
      <Text size="sm" mb={4}>
        Page: a screen of the app, held by one task while it works on it. Two pages may not share a
        file.
      </Text>
      <Text size="sm">
        Shared: code many pages use, such as components, styles or public files. A file a page also
        matches is the page’s.
      </Text>
    </HelpTip>
  );
}

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

/** Choose whether an area is a page or shared, and the route and label of a page. */
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
    <Group align="flex-end" gap="sm" wrap="wrap">
      <NativeSelect
        size="xs"
        label="Role"
        aria-label={`Area ${n} role`}
        data={ROLE_OPTIONS}
        value={role}
        w={140}
        onChange={(e) => {
          const value = e.currentTarget.value;
          if (isRoleChoice(value)) onChange({ role: value });
        }}
      />
      <RoleHelp />
      {role === AreaRole.Page ? (
        <TextInput
          size="xs"
          label="Route"
          aria-label={`Area ${n} route`}
          placeholder="/people (optional)"
          w={200}
          value={route}
          onChange={(e) => {
            onChange({ route: e.currentTarget.value });
          }}
        />
      ) : null}
      {role === AreaRole.Page && label !== undefined ? (
        <TextInput
          size="xs"
          label="Label"
          aria-label={`Area ${n} label`}
          placeholder={pageLabel({ name: name?.trim() ?? '' })}
          maxLength={40}
          w={200}
          value={label}
          onChange={(e) => {
            onChange({ label: e.currentTarget.value });
          }}
        />
      ) : null}
    </Group>
  );
}

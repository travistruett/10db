import { Alert, Button, Stack } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { FIELD_HOMES } from './general-field-homes';
import type { useProjectFields } from './project-fields-state';
import { sectionByKey } from './sections';

/**
 * When a field the page does not show blocks Save, names that field and links to its page; otherwise
 * nothing.
 */
export function HiddenFieldAlert({
  fields,
}: {
  readonly fields: ReturnType<typeof useProjectFields>;
}) {
  const home = fields.hiddenField === null ? null : FIELD_HOMES[fields.hiddenField];
  if (home === null) return null;
  return (
    <Alert color="red" variant="light" title="Can't save yet" role="alert">
      <Stack gap="xs" align="flex-start">
        {`${home.label} on ${sectionByKey(home.section).label} needs a change before anything saves.`}
        <Button
          variant="default"
          size="compact-sm"
          renderRoot={(props) => (
            <Link {...props} to="/settings/$section" params={{ section: home.section }} />
          )}
        >
          {`Open ${sectionByKey(home.section).label}`}
        </Button>
      </Stack>
    </Alert>
  );
}

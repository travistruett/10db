import { Alert, Button, Stack } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useReportUnsaved } from '../../shell/unsaved-guard';
import { SaveBar } from '../../shell/save-bar';
import { FIELD_HOMES } from './general-field-homes';
import type { useProjectFields } from './project-fields-state';
import { sectionByKey } from './sections';

/**
 * The save bar of a page of typed settings. It reports the page's edits so leaving asks first, and when
 * a field the page does not show blocks Save, it names that field and links to its page.
 */
export function ProjectSaveBar({
  fields,
}: {
  readonly fields: ReturnType<typeof useProjectFields>;
}) {
  useReportUnsaved(fields.dirty);
  const home = fields.hiddenField === null ? null : FIELD_HOMES[fields.hiddenField];
  return (
    <>
      {home === null ? null : (
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
      )}
      <SaveBar
        error={fields.saveError}
        note={fields.note}
        saving={fields.saving}
        onReset={fields.reset}
        onSave={fields.save}
      />
    </>
  );
}

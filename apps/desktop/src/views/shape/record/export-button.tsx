import type { ShapeId } from '@10db/contracts';
import { Button, Group, Popover, Stack, Text, TextInput } from '@mantine/core';
import { IconFileExport } from '@tabler/icons-react';
import { useState } from 'react';
import { useExportPlan } from '../../../daemon/plan-record-queries';
import { canChooseFolder, chooseFolder } from '../../../desktop/choose-folder';

// Export as Markdown: the builder picks a folder (the native panel in the app, a typed path in a
// browser) and the daemon writes the record there, or says why it won't.

export function ExportButton({ shapeId }: { readonly shapeId: ShapeId }) {
  const exported = useExportPlan(shapeId);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState('');
  // The folder panel's own failure, said where the daemon's refusal goes.
  const [panelError, setPanelError] = useState<string | null>(null);
  const send = (dir: string): void => {
    setTyping(false);
    exported.mutate(dir);
  };
  const pick = async (): Promise<void> => {
    setPanelError(null);
    if (!canChooseFolder()) {
      setTyping(true);
      return;
    }
    try {
      const dir = await chooseFolder('Choose a folder for the export');
      if (dir !== null) send(dir);
    } catch (error) {
      setPanelError(
        `Couldn't open the folder panel: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const failure = panelError ?? (exported.isError ? exported.error.message : null);
  return (
    <Stack gap={4} align="flex-end">
      <Popover opened={typing} onChange={setTyping} position="bottom-end" trapFocus>
        <Popover.Target>
          <Button
            variant="default"
            size="xs"
            leftSection={<IconFileExport size={14} stroke={1.5} />}
            loading={exported.isPending}
            onClick={() => {
              void pick();
            }}
          >
            Export as Markdown…
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (path.trim() !== '') send(path.trim());
            }}
          >
            <Group gap="xs" align="flex-end" wrap="nowrap">
              <TextInput
                label="Folder"
                placeholder="/Users/you/plan-exports"
                size="xs"
                w={300}
                data-autofocus
                value={path}
                onChange={(e) => {
                  setPath(e.currentTarget.value);
                }}
              />
              <Button type="submit" size="xs" disabled={path.trim() === ''}>
                Export
              </Button>
            </Group>
          </form>
        </Popover.Dropdown>
      </Popover>
      {failure === null ? null : (
        <Text size="xs" c="red" maw={420} ta="right" role="alert">
          {failure}
        </Text>
      )}
      {exported.isSuccess && panelError === null ? (
        <Text size="xs" c="dimmed" maw={420} ta="right" role="status">
          {`Exported ${String(exported.data.files.length)} files to ${exported.data.dir}`}
        </Text>
      ) : null}
    </Stack>
  );
}

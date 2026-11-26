import type { ProjectId } from '@10db/contracts';
import { Badge, Box, CloseButton, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { useEffect, useState, type RefObject } from 'react';
import type { DraftPick } from '../../conversation/drafts';
import { dropPreviewPicks, flashPreviewPick } from '../../desktop/preview';
import { pickSource, pickTitle } from './pick-message';

// Pick on Page spec §4: a page's picks waiting in its composer, above the input. A chip shows the crop,
// the number its badge has in the Preview, the element, its component and file, and the note; a click
// flashes the badge, and × drops the pick from the draft and the page.

function Crop({ file }: { readonly file: File | null }) {
  // A data address, since the window's policy lets an image load from `data:` and not from `blob:`.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (file === null) return;
    let current = true;
    const reader = new FileReader();
    reader.onload = () => {
      if (current && typeof reader.result === 'string') setSrc(reader.result);
    };
    reader.readAsDataURL(file);
    return () => {
      current = false;
    };
  }, [file]);
  const look = {
    borderRadius: 'var(--mantine-radius-sm)',
    display: 'block',
    flex: 'none',
  } as const;
  return src === null ? (
    <Box w={56} h={40} bg="var(--mantine-color-default-hover)" style={look} />
  ) : (
    <img
      src={src}
      alt=""
      width={56}
      height={40}
      style={{ objectFit: 'cover', objectPosition: 'top left', ...look }}
    />
  );
}

export interface PickChipsProps {
  readonly projectId: ProjectId;
  readonly route: string | null;
  readonly picks: readonly DraftPick[];
  readonly onRemove: (pickId: string) => void;
  /** Where the cursor goes when the Preview brings the window forward. */
  readonly headRef: RefObject<HTMLDivElement | null>;
}

export function PickChips({ projectId, route, picks, onRemove, headRef }: PickChipsProps) {
  if (picks.length === 0) return null;
  return (
    <Stack gap={6} pb={6} component="section" aria-label="Picks from the page">
      <Group gap={6} ref={headRef} tabIndex={-1} style={{ outline: 'none' }}>
        <Box w={6} h={6} bg="var(--mantine-color-pink-filled)" style={{ borderRadius: '50%' }} />
        <Text size="xs" c="dimmed">
          {picks.length} pick{picks.length === 1 ? '' : 's'} from {route ?? 'the page'}
        </Text>
      </Group>
      <Stack gap={4} component="ul" m={0} p={0}>
        {picks.map(({ pick, crop }, index) => {
          const source = pickSource(pick);
          return (
            <Group
              key={pick.id}
              component="li"
              wrap="nowrap"
              align="flex-start"
              gap="xs"
              p={6}
              bg="var(--mantine-color-body)"
              style={{ listStyle: 'none', borderRadius: 'var(--mantine-radius-sm)' }}
            >
              <UnstyledButton
                aria-label={`Show pick ${String(index + 1)} on the page`}
                onClick={() => {
                  void flashPreviewPick(projectId, pick.id);
                }}
                style={{ display: 'flex', gap: 'var(--mantine-spacing-xs)', flex: 1, minWidth: 0 }}
              >
                <Crop file={crop} />
                <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                  <Group gap={6} wrap="nowrap">
                    <Badge size="xs" circle color="pink" variant="filled">
                      {index + 1}
                    </Badge>
                    <Text size="xs" truncate>
                      {pickTitle(pick)}
                    </Text>
                  </Group>
                  {source.component === '' && source.file === '' ? null : (
                    <Text size="xs" ff="monospace" truncate>
                      <Text span inherit c="cyan">
                        {source.component}
                      </Text>{' '}
                      <Text span inherit c="dimmed">
                        {source.file}
                      </Text>
                    </Text>
                  )}
                  {pick.note === '' ? (
                    <Text size="xs" c="dimmed" fs="italic">
                      no note
                    </Text>
                  ) : (
                    <Text size="xs" lineClamp={2}>
                      {pick.note}
                    </Text>
                  )}
                </Stack>
              </UnstyledButton>
              <CloseButton
                size="sm"
                aria-label={`Remove pick ${String(index + 1)}`}
                onClick={() => {
                  onRemove(pick.id);
                  void dropPreviewPicks(projectId, [pick.id]);
                }}
              />
            </Group>
          );
        })}
      </Stack>
    </Stack>
  );
}

import { Alert, Anchor, Box, Loader, NavLink, Text } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useShapes } from '../daemon/shape-queries';
import { shortAgo } from '../views/factory/short-ago';
import { useNow } from './relative';
import { useSelectedProject } from './selected-project';

/** How many conversations the nav lists; the newest first. */
const LISTED = 8;

/** Shape's nav item with the project's conversations under it (title, state, age). */
export function ShapeNav({ pathname }: { readonly pathname: string }) {
  const { project } = useSelectedProject();
  const shapes = useShapes(project?.id ?? null);
  const now = useNow();
  const navigate = useNavigate();

  return (
    <>
      <NavLink
        component={Link}
        to="/shape"
        active={pathname === '/shape'}
        label="Shape"
        leftSection={<IconSparkles size={16} stroke={1.5} />}
      />
      <Box ml="md" pl="xs" aria-label="Conversations" role="group">
        {shapes.isLoading ? <Loader size="sm" aria-label="Loading conversations" /> : null}
        {shapes.isError ? (
          <Alert color="red" p="xs">
            <Text size="xs">Couldn&apos;t load conversations</Text>
          </Alert>
        ) : null}
        {shapes.isSuccess && shapes.data.length === 0 ? (
          <Text size="xs" c="dimmed">
            No conversations yet ·{' '}
            {/* Underlined always: a link inside a sentence can't rely on color alone (axe link-in-text-block). */}
            <Anchor component={Link} to="/shape" size="xs" underline="always">
              Shape Work…
            </Anchor>
          </Text>
        ) : null}
        {shapes.isSuccess
          ? shapes.data.slice(0, LISTED).map((shape) => (
              <NavLink
                key={shape.id}
                // A plain link the router navigates, so the id stays typed at its one call site.
                href={`/shape/${shape.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  void navigate({ to: '/shape/$shapeId', params: { shapeId: shape.id } });
                }}
                active={pathname === `/shape/${shape.id}`}
                label={shape.title}
                description={`${shape.state} · ${shortAgo(shape.updatedAt, now)}`}
                styles={{
                  label: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
                }}
              />
            ))
          : null}
      </Box>
    </>
  );
}

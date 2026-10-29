import { Avatar } from '@mantine/core';

/** A project's two-letter mark, so its name reads the same wherever the project is named. */
export function ProjectTile({
  name,
  size = 24,
}: {
  readonly name: string;
  readonly size?: number;
}) {
  return (
    <Avatar
      size={size}
      radius="sm"
      color="blue"
      variant="filled"
      aria-hidden="true"
      {...(size < 20 ? { fz: 8 } : {})}
    >
      {name.slice(0, 2).toUpperCase()}
    </Avatar>
  );
}

import { z } from 'zod';

const VersionText = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{12}$/);

/** The version a `VERSION` file holds; null when it is absent or not 12 lowercase hex digits. */
export function readSkillVersion(readFile: () => string): string | null {
  try {
    const parsed = VersionText.safeParse(readFile());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

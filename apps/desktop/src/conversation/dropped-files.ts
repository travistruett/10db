import { shapeFileKind, shapeFileRefusal, ShapeFileKind, type ShapeFileDto } from '@10db/contracts';

// Shape spec §5.4. The input checks a dropped file before it uploads, so the reason shows at once;
// the daemon checks again, and its words are shown when it still refuses.

/** What the file picker offers; a drop skips it, so the checks below still run. */
export const FILE_PICKER_ACCEPT = '.md,.markdown,.txt,.pdf,.png,.jpg,.jpeg,.webp';

const EXTENSION: Readonly<Record<string, string>> = {
  [ShapeFileKind.Png]: 'png',
  [ShapeFileKind.Jpeg]: 'jpg',
  [ShapeFileKind.Webp]: 'webp',
};

/** A pasted screenshot arrives as an image with a bare or missing name; it gets one the daemon accepts. */
export function nameImage(file: File): File {
  if (shapeFileKind(file.name) !== null) return file;
  const ext = EXTENSION[file.type];
  return ext === undefined ? file : new File([file], `pasted-image.${ext}`, { type: file.type });
}

export interface Upload {
  /** Uploads one file into the conversation, which exists by then. */
  upload(file: File): Promise<ShapeFileDto>;
  /** Makes the conversation the first accepted file belongs to, when there is none yet. */
  ensureConversation(): Promise<void>;
}

/**
 * Adds files one after another: a refused file is named with its reason and the rest carry on.
 * Answers every reason; the conversation is made only when a file is accepted.
 */
export async function addFiles(
  files: readonly File[],
  held: number,
  target: Upload,
): Promise<string[]> {
  const problems: string[] = [];
  let count = held;
  for (const file of files.map(nameImage)) {
    const refusal = shapeFileRefusal({
      name: file.name,
      size: file.size,
      mediaType: file.type,
      held: count,
    });
    if (refusal !== null) {
      problems.push(refusal);
      continue;
    }
    try {
      await target.ensureConversation();
      await target.upload(file);
      count += 1;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems;
}

import { z } from 'zod';
import { ProjectId, ShapeFileId, ShapeId } from './ids';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §5.4, §5.6. The files a
// builder drops into a conversation, and the text a terminal session hands over with start_shape.

const Timestamp = z.iso.datetime();

/** What a file is, by its extension: the types §5.4 accepts. */
export const ShapeFileKind = {
  Markdown: 'text/markdown',
  Text: 'text/plain',
  Pdf: 'application/pdf',
  Png: 'image/png',
  Jpeg: 'image/jpeg',
  Webp: 'image/webp',
} as const;
export type ShapeFileKind = (typeof ShapeFileKind)[keyof typeof ShapeFileKind];

const KIND_BY_EXTENSION: Readonly<Record<string, ShapeFileKind>> = {
  md: ShapeFileKind.Markdown,
  markdown: ShapeFileKind.Markdown,
  txt: ShapeFileKind.Text,
  pdf: ShapeFileKind.Pdf,
  png: ShapeFileKind.Png,
  jpg: ShapeFileKind.Jpeg,
  jpeg: ShapeFileKind.Jpeg,
  webp: ShapeFileKind.Webp,
};

export const SHAPE_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const SHAPE_FILES_MAX = 20;
/** What start_shape's inline files may total: a model emits them in one tool call. */
export const SHAPE_TEXT_FILES_MAX_BYTES = 256 * 1024;

/** The file's kind from its extension, or null when §5.4 doesn't accept it. */
export function shapeFileKind(name: string): ShapeFileKind | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return KIND_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

export type ShapeImageKind =
  typeof ShapeFileKind.Png | typeof ShapeFileKind.Jpeg | typeof ShapeFileKind.Webp;

/** Whether Claude sees the file as an image content block rather than a path to read. */
export const isShapeImage = (kind: ShapeFileKind): kind is ShapeImageKind =>
  kind === ShapeFileKind.Png || kind === ShapeFileKind.Jpeg || kind === ShapeFileKind.Webp;

/**
 * Why a dropped file is refused, in the words the input shows, or null. `held` is how many files the
 * conversation has already. The declared media type is not trusted: the extension decides.
 */
export function shapeFileRefusal(file: {
  readonly name: string;
  readonly size: number;
  readonly mediaType: string;
  readonly held: number;
}): string | null {
  if (shapeFileKind(file.name) === null)
    return `${file.name} can't be added: drop Markdown, plain text, PDF, PNG, JPEG or WebP`;
  if (file.size === 0) return `${file.name} is empty`;
  if (file.size > SHAPE_FILE_MAX_BYTES)
    return `${file.name} is ${String(Math.ceil(file.size / (1024 * 1024)))} MB; the limit is ${String(SHAPE_FILE_MAX_BYTES / (1024 * 1024))} MB`;
  if (file.held >= SHAPE_FILES_MAX)
    return `A conversation holds at most ${String(SHAPE_FILES_MAX)} files`;
  return null;
}

export const ShapeFileDto = z.object({
  id: ShapeFileId,
  shapeId: ShapeId,
  name: z.string(),
  mediaType: z.string(),
  size: z.int().min(0),
  /** Where the daemon keeps it; the session reads it with `Read`. */
  storedPath: z.string(),
  createdAt: Timestamp,
});
export type ShapeFileDto = z.infer<typeof ShapeFileDto>;

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt']);

/** A name and no path: nothing the daemon would copy from elsewhere on the Mac. */
const InlineFileName = z
  .string()
  .min(1)
  .max(100)
  .refine((name) => !/[/\\\0]/.test(name) && !name.startsWith('.') && !name.startsWith('~'), {
    message: 'A file is a name, never a path',
  })
  .refine(
    (name) => {
      const kind = shapeFileKind(name);
      return (
        kind !== null && TEXT_EXTENSIONS.has(name.slice(name.lastIndexOf('.') + 1).toLowerCase())
      );
    },
    {
      message:
        'start_shape takes Markdown or plain text files only; images and PDFs are dropped into the app',
    },
  );

export const StartShapeFile = z.object({ name: InlineFileName, content: z.string().min(1) });
export type StartShapeFile = z.infer<typeof StartShapeFile>;

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** `start_shape`: a conversation begun in a terminal session, with that session's summary first. */
export const StartShapeInput = z
  .object({
    projectId: ProjectId,
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(20_000),
    files: z.array(StartShapeFile).max(SHAPE_FILES_MAX).default([]),
  })
  .refine((input) => new Set(input.files.map((f) => f.name)).size === input.files.length, {
    message: 'Two files have the same name',
    path: ['files'],
  })
  .refine(
    (input) =>
      input.files.reduce((sum, f) => sum + byteLength(f.content), 0) <= SHAPE_TEXT_FILES_MAX_BYTES,
    { message: 'Files are 256 KB in all', path: ['files'] },
  );
export type StartShapeInput = z.infer<typeof StartShapeInput>;

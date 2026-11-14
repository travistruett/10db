import { File as BufferFile } from 'node:buffer';
import { vi } from 'vitest';

// jsdom replaces `FormData` and `File` with its own, which Node's fetch cannot send as multipart: the
// picture goes as "[object File]" or the request fails. A test that sends a multipart body puts Node's
// `FormData` back for the request (undone by `vi.unstubAllGlobals`) and makes its files with Node's
// `File`. MSW cannot parse that body back with `formData()` either, so `multipartParts` reads it.

/** Puts Node's `FormData` in place of jsdom's and answers Node's `File`. */
export async function useNodeMultipart(): Promise<typeof File> {
  const nodeForm = await new Response(new URLSearchParams()).formData();
  vi.stubGlobal('FormData', nodeForm.constructor);
  // Node's File is the web File; only its declared type differs.
  return BufferFile as unknown as typeof File;
}

/** A multipart body's text parts by name, and the file names of its file parts by name. */
export function multipartParts(body: string): {
  readonly text: Readonly<Record<string, string>>;
  readonly files: Readonly<Record<string, readonly string[]>>;
} {
  const text: Record<string, string> = {};
  const files: Record<string, string[]> = {};
  for (const part of body.split(/\r\n--[^\r\n]*/)) {
    const head = /name="([^"]+)"(?:; filename="([^"]+)")?/.exec(part);
    if (head === null) continue;
    const [, name = '', filename] = head;
    if (filename !== undefined) (files[name] ??= []).push(filename);
    else text[name] = part.slice(part.indexOf('\r\n\r\n') + 4);
  }
  return { text, files };
}

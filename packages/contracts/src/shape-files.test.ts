import { describe, expect, it } from 'vitest';
import {
  SHAPE_FILE_MAX_BYTES,
  SHAPE_FILES_MAX,
  SHAPE_TEXT_FILES_MAX_BYTES,
  shapeFileRefusal,
  StartShapeInput,
} from './shape-files';
import { mintId } from './ids';

// Shape spec §5.4: Markdown, plain text, PDF, PNG, JPEG and WebP, at most 20 MB each and 20 per
// conversation. §5.6: start_shape's files are inline text, 256 KB in all, never paths.

const MB = 1024 * 1024;

describe('shapeFileRefusal', () => {
  it.each([
    { name: 'Markdown', file: 'brief.md', size: 10, mediaType: 'text/markdown' },
    { name: 'Markdown by its other extension', file: 'brief.markdown', size: 10, mediaType: '' },
    { name: 'plain text', file: 'notes.txt', size: 10, mediaType: 'text/plain' },
    { name: 'a PDF', file: 'spec.pdf', size: 5 * MB, mediaType: 'application/pdf' },
    { name: 'a PNG', file: 'shot.PNG', size: 10, mediaType: 'image/png' },
    { name: 'a JPEG', file: 'photo.jpeg', size: 10, mediaType: 'image/jpeg' },
    { name: 'a JPG', file: 'photo.jpg', size: 10, mediaType: '' },
    { name: 'a WebP', file: 'pic.webp', size: 10, mediaType: 'image/webp' },
    {
      name: 'a file exactly at the limit',
      file: 'big.pdf',
      size: SHAPE_FILE_MAX_BYTES,
      mediaType: '',
    },
  ])('accepts $name', ({ file, size, mediaType }) => {
    expect(shapeFileRefusal({ name: file, size, mediaType, held: 0 })).toBeNull();
  });

  it.each([
    {
      name: 'a type that is not on the list',
      input: { name: 'run.sh', size: 10, mediaType: 'text/x-shellscript', held: 0 },
      reason: /run\.sh.*Markdown, plain text, PDF, PNG, JPEG or WebP/,
    },
    {
      name: 'a file with no extension',
      input: { name: 'README', size: 10, mediaType: 'text/plain', held: 0 },
      reason: /README.*Markdown, plain text, PDF, PNG, JPEG or WebP/,
    },
    {
      name: 'a GIF',
      input: { name: 'a.gif', size: 10, mediaType: 'image/gif', held: 0 },
      reason: /a\.gif/,
    },
    {
      name: 'a file over 20 MB',
      input: { name: 'big.pdf', size: SHAPE_FILE_MAX_BYTES + 1, mediaType: '', held: 0 },
      reason: /big\.pdf.*20 MB/,
    },
    {
      name: 'an empty file',
      input: { name: 'a.md', size: 0, mediaType: '', held: 0 },
      reason: /a\.md.*empty/,
    },
    {
      name: 'a twenty-first file',
      input: { name: 'a.md', size: 10, mediaType: '', held: SHAPE_FILES_MAX },
      reason: /at most 20 files/,
    },
  ])('refuses $name, saying why', ({ input, reason }) => {
    expect(shapeFileRefusal(input)).toMatch(reason);
  });
});

describe('StartShapeInput', () => {
  const projectId = mintId('Project');
  const base = { projectId, title: 'Board polish', summary: 'We talked about density.' };

  it('takes a summary and no files', () => {
    expect(StartShapeInput.parse(base)).toEqual({ ...base, files: [] });
  });

  it('takes inline text files', () => {
    const files = [{ name: 'notes.md', content: '# Notes' }];
    expect(StartShapeInput.parse({ ...base, files }).files).toEqual(files);
  });

  it.each([
    { name: 'a path with a slash', file: { name: 'docs/notes.md', content: 'x' } },
    { name: 'a path with a backslash', file: { name: 'docs\\notes.md', content: 'x' } },
    { name: 'a parent path', file: { name: '../notes.md', content: 'x' } },
    { name: 'a home path', file: { name: '~/notes.md', content: 'x' } },
    { name: 'a dotfile', file: { name: '.env', content: 'x' } },
    { name: 'an image', file: { name: 'shot.png', content: 'x' } },
    { name: 'a PDF', file: { name: 'spec.pdf', content: 'x' } },
    { name: 'no extension', file: { name: 'notes', content: 'x' } },
    { name: 'empty content', file: { name: 'notes.md', content: '' } },
  ])('refuses $name as a file name', ({ file }) => {
    expect(StartShapeInput.safeParse({ ...base, files: [file] }).success).toBe(false);
  });

  it('refuses files that together pass 256 KB of text', () => {
    const half = 'a'.repeat(SHAPE_TEXT_FILES_MAX_BYTES / 2 + 1);
    const parsed = StartShapeInput.safeParse({
      ...base,
      files: [
        { name: 'a.md', content: half },
        { name: 'b.md', content: half },
      ],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toMatch(/256 KB/);
  });

  it('counts bytes, not characters', () => {
    const wide = '€'.repeat(SHAPE_TEXT_FILES_MAX_BYTES / 3 + 1);
    expect(
      StartShapeInput.safeParse({ ...base, files: [{ name: 'a.md', content: wide }] }).success,
    ).toBe(false);
  });

  it('refuses more files than a conversation holds', () => {
    const files = Array.from({ length: SHAPE_FILES_MAX + 1 }, (_, i) => ({
      name: `f${String(i)}.md`,
      content: 'x',
    }));
    expect(StartShapeInput.safeParse({ ...base, files }).success).toBe(false);
  });

  it('refuses two files with one name', () => {
    const files = [
      { name: 'a.md', content: 'x' },
      { name: 'a.md', content: 'y' },
    ];
    expect(StartShapeInput.safeParse({ ...base, files }).success).toBe(false);
  });

  it('refuses a blank summary', () => {
    expect(StartShapeInput.safeParse({ ...base, summary: '  ' }).success).toBe(false);
  });
});

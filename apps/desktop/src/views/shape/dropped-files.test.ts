import { describe, expect, it, vi } from 'vitest';
import { addFiles, nameImage } from './dropped-files';

// Shape spec §5.4: refused with the reason before anything uploads; the rest carry on.

const file = (name: string, size: number, type = ''): File => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

function target() {
  const uploaded: string[] = [];
  let made = 0;
  return {
    uploaded,
    made: () => made,
    upload: vi.fn((f: File) => {
      uploaded.push(f.name);
      return Promise.resolve({} as never);
    }),
    ensureConversation: vi.fn(() => {
      made += 1;
      return Promise.resolve();
    }),
  };
}

describe('addFiles', () => {
  it('uploads what is accepted and names each refusal with its reason', async () => {
    const t = target();
    const problems = await addFiles(
      [
        file('brief.md', 10),
        file('run.sh', 10),
        file('big.pdf', 21 * 1024 * 1024),
        file('shot.png', 5),
      ],
      0,
      t,
    );
    expect(t.uploaded).toEqual(['brief.md', 'shot.png']);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/run\.sh.*Markdown, plain text, PDF, PNG, JPEG or WebP/);
    expect(problems[1]).toMatch(/big\.pdf.*20 MB/);
  });

  it('makes no conversation when every file is refused', async () => {
    const t = target();
    await addFiles([file('run.sh', 10)], 0, t);
    expect(t.made()).toBe(0);
  });

  it('refuses a file past the 20 the conversation holds, counting those it has', async () => {
    const t = target();
    const problems = await addFiles([file('a.md', 1), file('b.md', 1)], 19, t);
    expect(t.uploaded).toEqual(['a.md']);
    expect(problems).toEqual([expect.stringMatching(/at most 20 files/)]);
  });

  it('says what the daemon said when it refuses a file the input accepted', async () => {
    const t = target();
    t.upload.mockRejectedValueOnce(new Error('fake.png isn’t really a PNG'));
    const problems = await addFiles([file('fake.png', 4), file('ok.md', 4)], 0, t);
    expect(problems).toEqual(['fake.png isn’t really a PNG']);
    expect(t.uploaded).toEqual(['ok.md']);
  });
});

describe('nameImage', () => {
  it.each([
    {
      name: 'a pasted PNG',
      file: new File(['x'], '', { type: 'image/png' }),
      expected: 'pasted-image.png',
    },
    {
      name: 'a pasted JPEG',
      file: new File(['x'], 'image', { type: 'image/jpeg' }),
      expected: 'pasted-image.jpg',
    },
    {
      name: 'a named file',
      file: new File(['x'], 'shot.png', { type: 'image/png' }),
      expected: 'shot.png',
    },
    {
      name: 'something that is not an image',
      file: new File(['x'], 'notes', { type: 'text/plain' }),
      expected: 'notes',
    },
  ])('names $name', ({ file: f, expected }) => {
    expect(nameImage(f).name).toBe(expected);
  });
});

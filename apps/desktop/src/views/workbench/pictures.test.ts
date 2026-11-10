import { TASK_MESSAGE_PICTURES_MAX, TASK_PICTURE_MAX_BYTES } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { withPictures } from './pictures';

function file(name: string, type: string, size = 4): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** A file whose size reads `size` without holding the bytes. */
function sized(name: string, type: string, size: number): File {
  const f = file(name, type);
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('withPictures', () => {
  it.each<{ name: string; held: File[]; added: File[]; kept: string[]; refused: string[] }>([
    {
      name: 'PNG, JPEG and WebP are taken',
      held: [],
      added: [
        file('a.png', 'image/png'),
        file('b.jpg', 'image/jpeg'),
        file('c.webp', 'image/webp'),
      ],
      kept: ['a.png', 'b.jpg', 'c.webp'],
      refused: [],
    },
    {
      name: 'a pasted screenshot with no name gets one',
      held: [],
      added: [file('image', 'image/png')],
      kept: ['pasted-image.png'],
      refused: [],
    },
    {
      name: 'a GIF or a PDF is refused by name',
      held: [],
      added: [file('a.gif', 'image/gif'), file('spec.pdf', 'application/pdf')],
      kept: [],
      refused: [
        'a.gif can’t be added: paste a PNG, JPEG or WebP picture',
        'spec.pdf can’t be added: paste a PNG, JPEG or WebP picture',
      ],
    },
    {
      name: 'an empty file is refused',
      held: [],
      added: [file('a.png', 'image/png', 0)],
      kept: [],
      refused: ['a.png is empty'],
    },
    {
      name: 'a picture over the size limit is refused',
      held: [],
      added: [sized('big.png', 'image/png', TASK_PICTURE_MAX_BYTES + 1)],
      kept: [],
      refused: ['big.png is 21 MB; the limit is 20 MB'],
    },
    {
      name: 'a message holds at most its pictures, the rest refused',
      held: Array.from({ length: TASK_MESSAGE_PICTURES_MAX - 1 }, (_, i) =>
        file(`${String(i)}.png`, 'image/png'),
      ),
      added: [file('last.png', 'image/png'), file('over.png', 'image/png')],
      kept: [
        ...Array.from({ length: TASK_MESSAGE_PICTURES_MAX - 1 }, (_, i) => `${String(i)}.png`),
        'last.png',
      ],
      refused: [
        `over.png can’t be added: a message carries at most ${String(TASK_MESSAGE_PICTURES_MAX)} pictures`,
      ],
    },
    {
      name: 'pictures that together pass the message limit are refused',
      held: [sized('one.png', 'image/png', TASK_PICTURE_MAX_BYTES)],
      added: [
        sized('two.png', 'image/png', TASK_PICTURE_MAX_BYTES),
        sized('three.png', 'image/png', 1),
      ],
      kept: ['one.png', 'two.png'],
      refused: ['three.png can’t be added: a message’s pictures are at most 40 MB together'],
    },
  ])('$name', ({ held, added, kept, refused }) => {
    const result = withPictures(held, added);
    expect(result.pictures.map((p) => p.name)).toEqual(kept);
    expect(result.refused).toEqual(refused);
  });
});

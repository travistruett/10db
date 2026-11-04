const PAGE_LINES = 60;
const LINE =
  'The quick brown fox jumps over the lazy dog, and the slow lazy dog watches it go by again.';

/** A real PDF of full pages of text: small on disk, and far larger once a page is rendered to a picture. */
export function textPdf(pages: number): Buffer {
  const pageNumbers = Array.from({ length: pages }, (_, i) => i);
  const pageObject = (i: number): number => 4 + i * 2;
  const stream = (i: number): string => {
    const lines = Array.from(
      { length: PAGE_LINES },
      (_, n) => `(${String(i + 1)}.${String(n)} ${LINE}) Tj T*`,
    );
    return `BT /F1 9 Tf 11 TL 36 756 Td\n${lines.join('\n')}\nET`;
  };
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${String(pages)} /Kids [${pageNumbers.map((i) => `${String(pageObject(i))} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...pageNumbers.flatMap((i) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(pageObject(i) + 1)} 0 R >>`,
      `<< /Length ${String(stream(i).length)} >>\nstream\n${stream(i)}\nendstream`,
    ]),
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${String(i + 1)} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = [
    `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
  ].join('');
  const trailer = `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(body.length)}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

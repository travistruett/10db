import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { theme } from '../../../theme';
import { AttachmentView } from './attachment-view';
import { MOCKUP_CSP } from './safe-render';

// Shape spec §10.3: everything the session writes can be shaped by a pasted document, so nothing it
// attaches runs code or reaches the network.

it('renders a mockup in an iframe sandboxed with no permissions, through srcdoc', () => {
  const html =
    '<h1>Cards</h1><script>fetch("http://127.0.0.1:4999/projects").then(r => r.text())</script>' +
    '<img src="https://evil.example/x.png"><a href="https://evil.example">out</a>';
  // The renderers need no daemon: Mantine alone.
  render(
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <AttachmentView attachment={{ kind: 'mockup', html }} title="Cards" />
    </MantineProvider>,
  );
  const frame = screen.getByTitle('Mockup: Cards');
  expect(frame.tagName).toBe('IFRAME');
  // An empty sandbox: no allow-scripts, no allow-same-origin, nothing else.
  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.getAttribute('src')).toBeNull();
  const doc = frame.getAttribute('srcdoc') ?? '';
  expect(doc).toContain(html);
  expect(doc.indexOf(`content="${MOCKUP_CSP}"`)).toBeGreaterThan(-1);
  expect(doc.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(doc.indexOf(html));
});

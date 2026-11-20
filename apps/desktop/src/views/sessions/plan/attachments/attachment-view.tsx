import type { ShapeAttachment } from '@10db/contracts';
import { Box, Skeleton, Text, useComputedColorScheme } from '@mantine/core';
import { useEffect, useState } from 'react';
import { chartRefusal, chartSvg, mermaidSvg, mockupDocument, svgDataUrl } from './safe-render';

// Shape spec §10.3: one attachment, rendered inert. See safe-render.ts for what makes each safe.

type Drawn =
  | { readonly state: 'drawing' }
  | { readonly state: 'drawn'; readonly src: string }
  | { readonly state: 'failed'; readonly why: string };

/** Draws `draw` once per `key`, and forgets a drawing that finishes after the inputs changed. */
function useDrawing(key: string, draw: () => Promise<string>): Drawn {
  const [drawn, setDrawn] = useState<{ readonly key: string; readonly value: Drawn }>({
    key,
    value: { state: 'drawing' },
  });
  useEffect(() => {
    let live = true;
    draw().then(
      (svg) => {
        if (live) setDrawn({ key, value: { state: 'drawn', src: svgDataUrl(svg) } });
      },
      (error: unknown) => {
        if (live)
          setDrawn({
            key,
            value: { state: 'failed', why: error instanceof Error ? error.message : String(error) },
          });
      },
    );
    return () => {
      live = false;
    };
    // `draw` is rebuilt each render; `key` names what it draws.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return drawn.key === key ? drawn.value : { state: 'drawing' };
}

function Drawing({ drawn, label }: { readonly drawn: Drawn; readonly label: string }) {
  if (drawn.state === 'drawing') return <Skeleton height={120} aria-hidden="true" />;
  if (drawn.state === 'failed')
    return (
      <Text size="xs" c="dimmed">
        {`${label} couldn’t be drawn: ${drawn.why}`}
      </Text>
    );
  return <img src={drawn.src} alt={label} style={{ maxWidth: '100%', display: 'block' }} />;
}

function MermaidView({ source, title }: { readonly source: string; readonly title: string }) {
  const dark = useComputedColorScheme('dark') === 'dark';
  const drawn = useDrawing(`${dark ? 'dark' : 'light'}\0${source}`, () => mermaidSvg(source, dark));
  return <Drawing drawn={drawn} label={`Diagram: ${title}`} />;
}

function ChartView({
  spec,
  title,
}: {
  readonly spec: Readonly<Record<string, unknown>>;
  readonly title: string;
}) {
  const refusal = chartRefusal(spec);
  const drawn = useDrawing(JSON.stringify(spec), () =>
    refusal === null ? chartSvg(spec) : Promise.reject(new Error(refusal)),
  );
  if (refusal !== null)
    return (
      <Text size="xs" c="dimmed">
        {refusal}
      </Text>
    );
  return <Drawing drawn={drawn} label={`Chart: ${title}`} />;
}

function MockupFrame({ html, title }: { readonly html: string; readonly title: string }) {
  return (
    <Box
      component="iframe"
      // An empty sandbox: no allow-scripts, no allow-same-origin, no forms, popups or navigation.
      sandbox=""
      srcDoc={mockupDocument(html)}
      title={`Mockup: ${title}`}
      referrerPolicy="no-referrer"
      loading="lazy"
      w="100%"
      h={320}
      style={{
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-sm)',
        background: 'white',
      }}
    />
  );
}

export function AttachmentView({
  attachment,
  title,
}: {
  readonly attachment: ShapeAttachment;
  readonly title: string;
}) {
  switch (attachment.kind) {
    case 'mermaid':
      return <MermaidView source={attachment.source} title={title} />;
    case 'chart':
      return <ChartView spec={attachment.spec} title={title} />;
    case 'mockup':
      return <MockupFrame html={attachment.html} title={title} />;
  }
}

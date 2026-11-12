import { describe, expect, it } from 'vitest';
import { indexPageFiles, isRedirectOnly } from './route-pages';

describe('isRedirectOnly', () => {
  it.each([
    {
      name: 'a page that only redirects',
      text: `import { redirect } from "next/navigation";\nexport default function Page() {\n  redirect("/runs");\n}\n`,
      only: true,
    },
    {
      name: 'a permanent redirect with a typed argument',
      text: `export default async function Page({ params }: { params: Promise<{ id: string }> }) {\n  permanentRedirect(\`/runs/\${(await params).id}\`);\n}\n`,
      only: true,
    },
    {
      name: 'a page that redirects on one branch and renders on the other',
      text: `export default function Page() {\n  if (!ok) redirect("/");\n  return <Coaching />;\n}\n`,
      only: false,
    },
    { name: 'a page that renders', text: `export default () => <main>hi</main>;`, only: false },
    { name: 'a page that renders a fragment', text: `export default () => <></>;`, only: false },
    {
      name: 'a page that neither renders nor redirects',
      text: `export default () => null;`,
      only: false,
    },
  ])('$name', ({ text, only }) => {
    expect(isRedirectOnly(text)).toBe(only);
  });
});

describe('indexPageFiles', () => {
  it('finds the page file of the route folder and of each route group, with the path it shows', () => {
    const files = [
      'web/page.tsx',
      'web/app/page.tsx',
      'web/app/layout.tsx',
      'web/app/(app)/page.tsx',
      'web/app/(app)/loading.tsx',
      'web/app/(app)/friday/page.tsx',
      'web/app/(site)/docs/(content)/page.mdx',
    ];
    const app = {
      unit: 'web',
      routes: 'web/app',
      layoutFolders: [
        'web',
        'web/app',
        'web/app/(app)',
        'web/app/(site)',
        'web/app/(site)/docs',
        'web/app/(site)/docs/(content)',
      ],
    };
    expect(indexPageFiles(files, app)).toEqual([
      { file: 'web/app/page.tsx', route: '/' },
      { file: 'web/app/(app)/page.tsx', route: '/' },
      { file: 'web/app/(site)/docs/(content)/page.mdx', route: '/docs' },
    ]);
  });
});

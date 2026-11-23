/** The upload address the scripted Plan session hands `send_mockup_to_figma`, as `html_to_figma` returned one. */
export const FAKE_FIGMA_SUBMIT_URL =
  'https://mcp.figma.com/mcp/html_to_figma/8b0b822b-e1f0-4b12-90ba-d1003d7cd7a2/submit?promptId=p1&cssSelector=.win';
/** An asset link as Figma's code for a frame names one. */
export const FAKE_FIGMA_ASSET_URL =
  'https://www.figma.com/api/mcp/asset/235cbb23-a662-4d13-ba49-ac365ec6cdee.svg';

const FRAME_ANSWER = {
  success: true,
  fileUrl: 'https://www.figma.com/design/rvZrpBrtjeoBiCCBo5cyce?node-id=1-2',
  nodeIds: ['1:2'],
};
const ASSET_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#2a6"/></svg>';

/**
 * A `fetch` that answers as Figma did when a mock-up was sent and read back (the upload's answer and an asset),
 * for a daemon on the fake adapter, so the Figma round trip runs with no network.
 */
export const fakeFigmaFetch: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (init?.method === 'POST' && url.host === 'mcp.figma.com')
    return Promise.resolve(Response.json(FRAME_ANSWER));
  if (url.host === 'www.figma.com' && url.pathname.startsWith('/api/mcp/asset/'))
    return Promise.resolve(
      new Response(ASSET_SVG, { headers: { 'content-type': 'image/svg+xml' } }),
    );
  return Promise.resolve(new Response('not found', { status: 404 }));
};

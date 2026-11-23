import type { FigmaFrame, ShapeAttachmentId } from '@10db/contracts';

// The two buttons on a mock-up. Each is a note in the transcript and the ask the session receives (the
// turn starter's `prompt`), as a review press is. The session's Figma server does the reading and the
// file work; 10db's two tools post the mock-up and file what comes back (`figma.ts`).

export interface FigmaPressMockup {
  readonly id: ShapeAttachmentId;
  readonly key: string;
}

/** Open in Figma: the ask that has the session send a mock-up to a draft file. */
export function openInFigmaNote(
  mockup: FigmaPressMockup,
  project: string,
  fileKey: string | null,
): { note: string; instruction: string } {
  const instruction = [
    `Open in Figma: send the mock-up of "${mockup.key}" to Figma.`,
    `- attachmentId ${mockup.id} · key ${mockup.key}`,
    `- Figma file: ${fileKey ?? 'none yet'}`,
    '',
    fileKey === null
      ? `1. Call whoami on your Figma server, then create_new_file: a design file named "${project} mock-ups" in the builder's one plan.`
      : `1. Use the stored Figma file ${fileKey}; do not make a new one.`,
    '2. Call html_to_figma with that file key and no cssSelector. It answers an upload address (submitUrl).',
    `3. Call send_mockup_to_figma with attachmentId ${mockup.id} and that submitUrl. 10db posts the mock-up to Figma itself; do not fetch or curl the address.`,
    '4. Reply with the frame link in one line.',
    'If your Figma server is not connected or refuses, say so in one line and file nothing.',
  ].join('\n');
  return { note: `Open in Figma: ${mockup.key}`, instruction };
}

/** Bring Back from Figma: the ask that has the session read a frame and file it as a new mock-up. */
export function bringBackNote(
  mockup: FigmaPressMockup,
  frame: FigmaFrame,
): { note: string; instruction: string } {
  const instruction = [
    `Bring back from Figma: read the frame of the mock-up of "${mockup.key}" and file it as a new version.`,
    `- attachmentId ${mockup.id} · key ${mockup.key}`,
    `- Figma file ${frame.fileKey} · node ${frame.nodeId}`,
    '',
    `1. Call get_design_context on file ${frame.fileKey}, node ${frame.nodeId}: one read. Its screenshot is the target.`,
    "2. Turn the code it returns into one self-contained HTML document: inline CSS, no scripts, no external URLs except Figma's asset URLs (https://www.figma.com/api/mcp/asset/…), and fonts mapped to the mock-up's system font stack.",
    `3. Call file_figma_version with attachmentId ${mockup.id} and that HTML. 10db inlines the assets and files it as a new version of the mock-up.`,
    '4. Reply in one line saying what changed from the last version.',
    'If your Figma server is not connected or its read limit is reached, say so in one line and file nothing.',
  ].join('\n');
  return { note: `Bring back from Figma: ${mockup.key}`, instruction };
}

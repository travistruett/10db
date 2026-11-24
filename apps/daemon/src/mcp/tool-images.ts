import type { ShapeImage } from '../sessions';

/** The words sent with a tool's pictures to a Codex session; 10db's own, so no tool output speaks as the builder. */
export const TOOL_PICTURES_CAPTION =
  'The pictures your last tool call returned. Its text came back as the tool result.';

/**
 * What a tool answers when its result is pictures: the MCP endpoint turns it into text and image
 * content blocks, which the session receives as the tool's result. Any other output is JSON text.
 * A session whose agent drops image blocks in a tool result is handed the pictures as a message
 * too (`McpDeps.showImages`).
 */
export class ToolImages {
  readonly text: string;
  readonly images: readonly ShapeImage[];

  constructor(text: string, images: readonly ShapeImage[]) {
    this.text = text;
    this.images = images;
  }
}

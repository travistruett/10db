# Plan in Sessions, slice 5: files by content, Codex and PDFs, Ask for Changes

Spec: `docs/superpowers/specs/2026-11-19-10db-plan-in-sessions-design.md` §2 (mock-ups), §6 (Files), §9.
Design review (§4) is planned on its own page.

## Brief

- **What changes for the builder:** a session takes any file whose bytes are text (`.vtt`, `.srt`, `.csv`,
  `.json`, code), plus PDFs and images as before, and `.docx` and `.pptx`, which 10db turns into text at upload.
  The file picker stops filtering by extension. A Codex session gets a PDF's text, because Codex can't read
  a PDF. A mock-up under a row gets **Ask for Changes**, which puts a draft naming it in the composer.
- **What it buys:** meeting transcripts, data and decks go straight into planning, on both providers.
- **What could go wrong, and how we'd know:** a binary file read as text (the check refuses NUL bytes and
  invalid UTF-8, and its unit test covers it); a large PDF slowing the upload (extraction has a time and
  size cap, and on failure the PDF is still kept with a note); bundling `unpdf` into the daemon (`make
  build` and the e2e both run the bundle).
- **Calls you might disagree with:** the converted text is what's kept for `.docx` and `.pptx`, not the
  original (the row keeps the original name). A PDF keeps both: the PDF, and its text beside it as
  `<stored>.txt`.
- **Needed from you:** nothing.

## Sizes

A: Feature (the content check is a parser and gets one unit test). B: Small, folded into A. D: Small.

## Provider parity

Claude reads PDFs and images itself, so nothing changes there. Codex 0.167 takes only `text`, `image`,
`localImage`, `audio`, `skill` and `mention` input (`codex-generated/ts/v2/UserInput.ts`), and its
`view_image` takes PNG, JPEG and WebP only, so a PDF's intake line in a Codex session points at the extracted
text file and says so. A PDF with no extractable text (a scan) says so to Codex only; Claude reads the scan itself. `.docx`, `.pptx`
and text files are text everywhere.

## Parts

1. **Content check** (`packages/contracts/src/shape-files.ts`, `apps/daemon/src/conversation/file-check.ts`,
   `apps/daemon/src/shape/dropped-files.ts`). The kind comes from the bytes:
   - PNG, JPEG, WebP or PDF by magic bytes (the existing `SIGNATURES`);
   - a ZIP (`PK\x03\x04`) holding `word/document.xml` is a docx, and one holding `ppt/slides/` is a pptx;
   - otherwise text when the bytes decode as UTF-8 (`TextDecoder('utf-8', { fatal: true })`, a BOM allowed)
     and hold no NUL;
   - anything else is refused with "<name> can't be added: drop a text file, PDF, image, .docx or .pptx".

   The pure classifier lives in the daemon (`conversation/file-kind.ts`) with one table test. The
   contracts keep the size and count refusal (`shapeFileRefusal` minus the extension check) so the input
   still says it at once. `start_shape`'s inline files take any safe name, since their content is text by
   construction. The row's `mediaType` becomes the source of truth: `plan-parts.ts` `imagesOf`,
   `picture-budget.ts` and `inline-budget.ts` `isImageName` read the row's kind, not the name. A task
   thread's pasted pictures (`conversation/pictures.ts`) stay images only and are not touched.
2. **docx and pptx to text** (`apps/daemon/src/conversation/office-text.ts`). Unzip with `fflate` (no
   dependencies; pin it exactly, latest stable). docx: the `<w:t>` runs of each `<w:p>`, one line per
   paragraph. pptx: `ppt/slides/slideN.xml` in N order, `<a:t>` per `<a:p>`, under a `## Slide N` heading.
   Decode the five XML entities and numeric references. The stored file is `<name>.md` and the row keeps
   the dropped name with `text/markdown`. A decompressed size cap (50 MB) refuses a zip bomb.
3. **PDF text for Codex (B)** (`apps/daemon/src/conversation/pdf-text.ts`). Extract with `unpdf` (its
   bundled serverless PDF.js, no worker; pin it exactly) at upload, written beside the PDF as
   `<storedPath>.txt` (0600). Cap it at 30 s, and at 2 MB of text, cut where it stops with a line saying
   so. A failure or empty text writes nothing and logs. The intake line (`plan-parts.ts` `intakeText`)
   gets the session's provider, and for Codex a PDF reads
   `[file] <path>.txt (<name>: the PDF's text; Codex can't read a PDF)`, or
   `(<name>: a PDF with no text 10db could read)`. Check that `make build`'s esbuild bundle runs it; if
   `unpdf` needs to be external like `playwright-core`, make it so.
4. **Desktop** (`apps/desktop/src/conversation/dropped-files.ts`): `FILE_PICKER_ACCEPT` goes (the picker
   takes any file), and `nameImage` stays for pasted images. The input refuses only size and count; the
   daemon's words show for the rest, as they do today.
5. **Ask for Changes (D)** (`views/sessions/plan/attachments/row-attachments.tsx`): beside Approve on a
   mock-up, **Ask for Changes** puts `Change the mock-up for "<task title>": ` in the session's composer
   draft (`conversation/drafts.ts`, through the chat tab's `onDraft`) and focuses it. Nothing is sent.
   Review ▾ already reads every pending row (slice 4), so nothing more is needed there.

## Tests

- One unit test of the classifier's table (`conversation/file-kind.test.ts`): PNG, JPEG, WebP, PDF, docx,
  pptx, plain UTF-8, a BOM, NUL bytes, invalid UTF-8, an unrelated zip. It earns its place as a parser
  (spec §10).
- The docx and pptx extraction runs inside that test on two tiny zips built with `fflate`.
- `e2e/sessions.spec.ts`: extend the existing file drop with a `.csv` (accepted) and a binary (refused,
  with its words), and press Ask for Changes on a mock-up to see the draft. No new spec file.
- Docs: the notes in `apps/daemon/src/shape/AGENTS.md`, `apps/daemon/src/conversation/AGENTS.md` and
  `views/sessions/plan/AGENTS.md`; spec §6's "Verified in slice 5's research" line is filled in.

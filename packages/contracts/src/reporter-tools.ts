import { z } from 'zod';
import { TaskScreenId } from './ids';
import { ReportLinearPostInput } from './linear-posts';

/** The tools on 10db's own server that a Linear reporter's session calls. */
export const ReporterToolName = {
  ReportLinearPost: 'report_linear_post',
  UploadLinearPicture: 'upload_linear_picture',
} as const;
export type ReporterToolName = (typeof ReporterToolName)[keyof typeof ReporterToolName];

/** One of the pictures the brief offered, sent by 10db to the signed URL Linear's `prepare_file_upload` returned. */
export const UploadLinearPictureInput = z.strictObject({
  pictureId: TaskScreenId,
  /** `uploadRequest.url` from `prepare_file_upload`. */
  uploadUrl: z.url().max(8192),
  /** `uploadRequest.headers` from `prepare_file_upload`, exactly as returned. */
  headers: z.record(z.string().max(256), z.string().max(1024)),
});
export type UploadLinearPictureInput = z.infer<typeof UploadLinearPictureInput>;

export const ReporterToolInputs = {
  [ReporterToolName.ReportLinearPost]: ReportLinearPostInput,
  [ReporterToolName.UploadLinearPicture]: UploadLinearPictureInput,
} as const;

/** What the reporter's agent reads about each tool. */
export const REPORTER_TOOL_DESCRIPTIONS: Readonly<Record<ReporterToolName, string>> = {
  [ReporterToolName.ReportLinearPost]:
    'Record the updates you made on the issue, by their post ids: the comment ids you wrote, the status you set and any attachment. Or record them as withheld, naming the pattern a refused write matched. Call it once per update you finished.',
  [ReporterToolName.UploadLinearPicture]:
    "Upload one of the pictures your brief lists to Linear. Call Linear's prepare_file_upload first with the picture's file name, contentType image/png and its exact size, then call this at once with the picture's id and the uploadRequest's url and headers exactly as Linear returned them. The signed URL lasts 60 seconds. When it succeeds, put the markdown prepare_file_upload returned in your comment.",
};

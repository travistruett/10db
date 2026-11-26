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
    "Hand 10db the comment for one owed update: its post id and the comment's body, nothing else (no footer; 10db adds it). Or give the post id with nothingToReport true when the update has nothing to say. When the update names a default status move, also give status: current, the issue's status name from get_issue, and statuses, every status of its team from list_issue_statuses (each with its name and type, and its position when Linear shows one); 10db picks the move and refuses the call without them. The result's next lists the calls to make, in order, each with its arguments unchanged: save_comment and save_issue, or, when the update shows pictures, Linear's prepare_file_upload for one file and then this tool again with the post id alone, which answers the next file or the comment. Call it once per owed update, and again only when next says so.",
  [ReporterToolName.UploadLinearPicture]:
    "Upload one of the pictures your brief lists to Linear. Call Linear's prepare_file_upload first with the picture's file name, contentType image/png and its exact size, then call this at once with the picture's id and the uploadRequest's url and headers exactly as Linear returned them. The signed URL lasts 60 seconds. When it succeeds, put the markdown prepare_file_upload returned in your comment.",
};

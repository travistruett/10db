import { EventType, NoticePostedData } from '@10db/contracts';
import { listEventsAfter, type DbReader } from '@10db/db';

/** The notices posted so far, oldest first, read back from the event log. */
export function noticesPosted(db: DbReader): NoticePostedData[] {
  return listEventsAfter(db, 0, 100_000)
    .filter((e) => e.type === EventType.NoticePosted)
    .map((e) => NoticePostedData.parse(e.data));
}

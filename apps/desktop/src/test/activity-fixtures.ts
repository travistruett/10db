import { mintId, type ActivityPageDto, type ActivityRow } from '@10db/contracts';
import { http, HttpResponse } from 'msw';
import { daemonUrl, server } from './daemon';

let nextSeq = 100;

/** One Activity row as the daemon answers it; a test overrides what it reads. */
export function activityRowDto(over: Partial<ActivityRow> = {}): ActivityRow {
  nextSeq += 1;
  const at = over.at ?? new Date().toISOString();
  return {
    projectId: mintId('Project'),
    taskId: null,
    key: `notice-${String(nextSeq)}`,
    tone: 'info',
    line: `Something happened ${String(nextSeq)}`,
    body: 'It asked nothing.',
    seq: nextSeq,
    at,
    firstAt: at,
    count: 1,
    ...over,
  };
}

/**
 * Serves `GET /activity/page` from an array read on every request, so a test changes what is served by
 * changing the array. Rows are paged by `after` (a row's `seq`) and narrowed by `task`, `project` and `q`.
 * Returns every query asked, in order.
 */
export function serveActivity(rows: ActivityRow[]): Record<string, string>[] {
  const asked: Record<string, string>[] = [];
  server.use(
    http.get(daemonUrl('/activity/page'), ({ request }) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      asked.push(query);
      const needle = query['q']?.toLowerCase();
      const size = Number(query['pageSize'] ?? '50');
      const after = query['after'] === undefined ? Infinity : Number(query['after']);
      const matching = rows
        .filter(
          (row) =>
            (query['task'] === undefined || row.taskId === query['task']) &&
            (query['project'] === undefined || row.projectId === query['project']) &&
            (needle === undefined ||
              row.line.toLowerCase().includes(needle) ||
              row.body.toLowerCase().includes(needle)) &&
            row.seq < after,
        )
        .sort((a, b) => b.seq - a.seq);
      const page = matching.slice(0, size);
      const last = page[page.length - 1];
      const dto: ActivityPageDto = {
        rows: page,
        next: matching.length > size && last !== undefined ? last.seq : null,
      };
      return HttpResponse.json(dto);
    }),
  );
  return asked;
}

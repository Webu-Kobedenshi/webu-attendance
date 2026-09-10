// GitHub Actions の定期実行対象日。
// workflow_dispatch（手動実行）はこの一覧に関係なく実行できる。
export const SCHEDULED_ACTIVITY_DATES = [
  "2026-09-17",
  "2026-10-01",
  "2026-10-08",
  "2026-10-15",
  "2026-10-22",
  "2026-10-29",
  "2026-11-05",
  "2026-11-12",
  "2026-11-19",
  "2026-11-26",
  "2026-12-03",
  "2026-12-10",
  "2026-12-17",
] as const;

const scheduledActivityDateSet = new Set<string>(SCHEDULED_ACTIVITY_DATES);

/**
 * 定期実行なら活動日だけ、手動実行なら任意の日に処理を許可する。
 */
export function shouldRunForActivityDate(
  date: string,
  eventName = process.env.GITHUB_EVENT_NAME,
): boolean {
  return eventName !== "schedule" || scheduledActivityDateSet.has(date);
}

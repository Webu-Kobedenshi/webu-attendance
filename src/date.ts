// 設計意図:
// - JST での「今日の日付」と現在時刻の ISO 文字列を提供する
// - GitHub Actions ランナーは UTC で動くため、明示的に JST に変換する
// - Intl.DateTimeFormat を使うことで、外部ライブラリ不要

const JST_TIMEZONE = "Asia/Tokyo";

/**
 * JST の YYYY-MM-DD 形式の日付文字列を返す
 */
export function todayJST(): string {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    // sv-SE ロケールは YYYY-MM-DD 形式を返すという豆知識
    timeZone: JST_TIMEZONE,
  });
  return formatter.format(new Date());
}

/**
 * JST のオフセット付き ISO 文字列を返す（例: 2026-05-12T15:00:23+09:00）
 * activity_log の時刻記録用
 */
export function nowJSTISO(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: JST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  // sv-SE は "2026-05-12 15:00:23" を返すので、T と +09:00 を補う
  const formatted = formatter.format(now).replace(" ", "T");
  return `${formatted}+09:00`;
}

// 設計意図:
// - raw_log と members を入力に、dashboard の2次元配列を返す純粋関数
// - 実際のシート操作はしない（呼び出し側で sheets.ts の関数を呼ぶ）
// - これにより「ロジックのテスト」と「シート操作のテスト」を分離できる

import type { Member, RawLogRow } from "./sheets.js";

const LEGEND = "○=出席 ×=欠席 △=未回答";

/**
 * メンバーの所属チームをソートキーとして取り出す
 *
 * 設計意図:
 * - 「team1/team2/team3」という運用ルールに合わせて /^team/i で拾う
 * - 該当ロールがない人は U+FFFF を返して末尾に集める
 *   (U+FFFF は Unicode の通常文字より大きいので必ず後ろにくる)
 * - 命名規則を変える時はここの正規表現だけ修正すればよい
 */
function teamKey(roles: string[]): string {
  return roles.find((r) => /^team/i.test(r)) ?? "￿";
}

/**
 * 出欠ステータスを記号に変換
 */
function attendanceSymbol(status: string | undefined): string {
  switch (status) {
    case "出席":
      return "○";
    case "欠席":
      return "×";
    case "未回答":
      return "△";
    default:
      return ""; // 記録なし（メンバー未参加の活動日など）
  }
}

/**
 * dashboard の2次元配列を生成する
 *
 * 出力形式:
 *   [0]: ヘッダー行 [凡例, "表示名", "ロール", 日付1, 日付2, ...]
 *   [1..]: メンバーごとの行 ["", 表示名, ロール, ○/×/△/空, ...]
 *
 * 並び順:
 *   - 列の日付: 古い順（左→右）
 *   - 行のメンバー: ロール → 表示名 のアルファベット順
 *
 * @param rawLog raw_log の全レコード
 * @param members active メンバー一覧
 */
export function buildDashboard(
  rawLog: RawLogRow[],
  members: Member[],
): string[][] {
  // [1] 出現する活動日を集めてソート（古い順）
  const dateSet = new Set<string>();
  for (const row of rawLog) {
    if (row.date) dateSet.add(row.date);
  }
  const dates = Array.from(dateSet).sort(); // YYYY-MM-DD は文字列ソートで日付順になる

  // [2] (discordId, date) → attendance のマップを作る
  const attendanceMap = new Map<string, string>();
  for (const row of rawLog) {
    const key = `${row.discordId}__${row.date}`;
    attendanceMap.set(key, row.attendance);
  }

  // [3] discordId → 最新の global_name のマップを作る
  // 各メンバーについて、最新の recordedAt を持つレコードの global_name を採用
  const latestNameMap = new Map<string, { name: string; recordedAt: string }>();
  for (const row of rawLog) {
    if (!row.discordId || !row.globalName) continue;
    const existing = latestNameMap.get(row.discordId);
    if (!existing || row.recordedAt > existing.recordedAt) {
      latestNameMap.set(row.discordId, {
        name: row.globalName,
        recordedAt: row.recordedAt,
      });
    }
  }

  // [4] メンバーをソート（チーム → 表示名）
  //
  // チームの判定: ロール名のうち /^team/i にマッチする最初のものを「team キー」とする
  // - team を持たない人(管理だけ、OB だけ、ロール未付与)は team キー = "￿" で末尾に集める
  // - team1 < team2 < team3 のように Unicode 順で期待通り並ぶ
  // - ロール命名規則を変える時は teamKey() の正規表現だけ書き換えれば済む
  //
  // 表示名は raw_log の最新があればそれを使い、なければ members の displayName
  const sortedMembers = [...members].sort((a, b) => {
    const teamA = teamKey(a.roles);
    const teamB = teamKey(b.roles);
    if (teamA !== teamB) return teamA.localeCompare(teamB);
    const nameA = latestNameMap.get(a.discordId)?.name ?? a.displayName;
    const nameB = latestNameMap.get(b.discordId)?.name ?? b.displayName;
    return nameA.localeCompare(nameB, "ja");
  });

  // [5] ヘッダー行を組み立て
  const header = [LEGEND, "表示名", "ロール", ...dates];

  // [6] メンバー行を組み立て
  const memberRows = sortedMembers.map((member) => {
    const displayName = latestNameMap.get(member.discordId)?.name ?? member.displayName;
    const cells = dates.map((date) => {
      const key = `${member.discordId}__${date}`;
      return attendanceSymbol(attendanceMap.get(key));
    });
    return ["", displayName, member.roles.join(", "), ...cells];
  });

  return [header, ...memberRows];
}

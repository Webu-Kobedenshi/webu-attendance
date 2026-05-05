// 設計意図:
// - Sheets API クライアントの共通初期化と、シート操作を関数として切り出す
// - 「今日の activity_log を検索」と「activity_log に追記」の2つを提供
// - 後で workflow B が「status を collected に更新」するための関数も追加予定

import { google, sheets_v4 } from "googleapis";
import { config } from "./config.js";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

let cachedClient: sheets_v4.Sheets | null = null;

export function getSheetsClient(): sheets_v4.Sheets {
  if (cachedClient) return cachedClient;

  const auth = new google.auth.GoogleAuth({
    credentials: config.google.credentials,
    scopes: SCOPES,
  });

  cachedClient = google.sheets({ version: "v4", auth });
  return cachedClient;
}

export type ActivityLogRow = {
  date: string;
  messageId: string;
  status: "posted" | "collected" | "failed";
  postedAt: string;
  collectedAt: string;
};

/**
 * 指定日の activity_log レコードを返す（なければ null）
 * 冪等性のチェックに使う
 */
export async function findActivityLogByDate(
  date: string,
): Promise<ActivityLogRow | null> {
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: "activity_log!A2:E",
  });

  const rows = res.data.values ?? [];
  const found = rows.find((row) => row[0] === date);
  if (!found) return null;

  return {
    date: found[0] ?? "",
    messageId: found[1] ?? "",
    status: (found[2] as ActivityLogRow["status"]) ?? "posted",
    postedAt: found[3] ?? "",
    collectedAt: found[4] ?? "",
  };
}

/**
 * activity_log に新規レコードを追加（Poll 投稿直後に呼ぶ）
 */
export async function appendActivityLog(params: {
  date: string;
  messageId: string;
  postedAt: string;
}): Promise<void> {
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.google.sheetId,
    range: "activity_log!A:E",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          params.date,
          params.messageId,
          "posted",
          params.postedAt,
          "", // collectedAt は workflow B で埋める
        ],
      ],
    },
  });
}

export type Member = {
  discordId: string;
  displayName: string;
  roles: string[];   // シート上はカンマ区切り文字列、コード内では配列
  joinedAt: string;
};

const MEMBERS_HEADER = ["discordId", "displayName", "roles", "joinedAt"];

/**
 * members シートから全メンバーを取得
 *
 * 設計意図:
 * - members シートに居る = 出欠集計の対象、というシンプルなルール
 * - 「Discord 側の状態が真実」前提で、Sheet 側で active/inactive を二重管理しない
 * - We部の規模では数十行なのでパフォーマンス問題なし
 */
export async function getMembers(): Promise<Member[]> {
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: "members!A2:D",
  });

  const rows = res.data.values ?? [];
  return rows
    .map((row) => ({
      discordId: row[0] ?? "",
      displayName: row[1] ?? "",
      roles: parseRoles(row[2] ?? ""),
      joinedAt: row[3] ?? "",
    }))
    .filter((m) => m.discordId !== "");
}

function parseRoles(s: string): string[] {
  return s
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

/**
 * members シートを Discord から取得した内容で全上書きする
 *
 * 設計意図:
 * - 「Discord 側の状態が真実」前提なので、merge ではなく全消し→全書き
 * - 旧スキーマ(5列: 末尾に status 列があった)を残さないため A:E をクリア
 */
export async function overwriteMembers(members: Member[]): Promise<void> {
  const sheets = getSheetsClient();

  // [1] 既存シートを全消し(旧スキーマの status 列も含めて A:E)
  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.google.sheetId,
    range: "members!A:E",
  });

  // [2] ヘッダー + データを書き込む
  const values: string[][] = [
    MEMBERS_HEADER,
    ...members.map((m) => [
      m.discordId,
      m.displayName,
      m.roles.join(","),
      m.joinedAt,
    ]),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.google.sheetId,
    range: "members!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

export type AttendanceStatus = "出席" | "欠席" | "未回答";

export type RawLogRow = {
  date: string;
  discordId: string;
  globalName: string;
  username: string;
  attendance: AttendanceStatus;
  recordedAt: string;
};

/**
 * raw_log を全件読んで、(日付, Discord ID) → 行番号のマップを返す
 *
 * 設計意図:
 * - UPSERT のために、既存行の場所を特定する必要がある
 * - 行番号は 1-indexed で、シート上の実行番号と一致させる
 *   （ヘッダーが1行目、データは2行目から）
 */
async function getRawLogIndex(): Promise<Map<string, number>> {
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: "raw_log!A2:F",
  });

  const rows = res.data.values ?? [];
  const index = new Map<string, number>();

  rows.forEach((row, i) => {
    const date = row[0] ?? "";
    const discordId = row[1] ?? "";
    if (date && discordId) {
      // i=0 はシート上の2行目なので +2
      index.set(`${date}__${discordId}`, i + 2);
    }
  });

  return index;
}

/**
 * raw_log に複数レコードを UPSERT する
 *
 * 設計意図:
 * - 既存レコード(同日同メンバー)は更新、新規は追加
 * - batchUpdate で API 呼び出しを最小化
 * - 冪等性: 何度実行しても同じ結果になる
 */
export async function upsertRawLog(rows: RawLogRow[]): Promise<{
  updated: number;
  appended: number;
}> {
  const sheets = getSheetsClient();
  const index = await getRawLogIndex();

  const updates: { range: string; values: string[][] }[] = [];
  const appends: string[][] = [];

  for (const row of rows) {
    const key = `${row.date}__${row.discordId}`;
    const values = [
      row.date,
      row.discordId,
      row.globalName,
      row.username,
      row.attendance,
      row.recordedAt,
    ];

    if (index.has(key)) {
      const rowNum = index.get(key)!;
      updates.push({
        range: `raw_log!A${rowNum}:F${rowNum}`,
        values: [values],
      });
    } else {
      appends.push(values);
    }
  }

  // 既存レコードは batchUpdate で一括更新
  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updates,
      },
    });
  }

  // 新規レコードは append で一括追加
  if (appends.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.google.sheetId,
      range: "raw_log!A:F",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: appends },
    });
  }

  return { updated: updates.length, appended: appends.length };
}

/**
 * activity_log の status を "collected" に更新し、collectedAt を埋める
 */
export async function markActivityLogCollected(params: {
  date: string;
  collectedAt: string;
}): Promise<void> {
  const sheets = getSheetsClient();

  // 全件読んで対象行を特定
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: "activity_log!A2:E",
  });

  const rows = res.data.values ?? [];
  const targetIndex = rows.findIndex((row) => row[0] === params.date);
  if (targetIndex === -1) {
    throw new Error(`activity_log に ${params.date} のレコードがありません`);
  }

  const rowNum = targetIndex + 2; // ヘッダーぶん +2

  // C列(status)とE列(collectedAt)だけ更新
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.google.sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `activity_log!C${rowNum}`,
          values: [["collected"]],
        },
        {
          range: `activity_log!E${rowNum}`,
          values: [[params.collectedAt]],
        },
      ],
    },
  });
}

/**
 * raw_log を全件取得する（dashboard 生成用）
 *
 * 設計意図:
 * - 既存の getRawLogIndex は「行番号マップ」だけを返すが、
 *   dashboard 生成では中身も必要なので別関数として作る
 * - 関心の分離（UPSERT 用 vs 集計用）
 */
export async function getAllRawLog(): Promise<RawLogRow[]> {
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: "raw_log!A2:F",
  });

  const rows = res.data.values ?? [];
  return rows.map((row) => ({
    date: row[0] ?? "",
    discordId: row[1] ?? "",
    globalName: row[2] ?? "",
    username: row[3] ?? "",
    attendance: (row[4] ?? "未回答") as AttendanceStatus,
    recordedAt: row[5] ?? "",
  }));
}

/**
 * dashboard シートを全消しして書き直す
 *
 * 設計意図:
 * - 「全消し→全書き直し」方式で実装をシンプルに保つ
 * - clear と update を1回ずつの API 呼び出しで完結
 * - values が空の値（メンバー未参加など）は空文字で埋める
 */
export async function rewriteDashboard(values: string[][]): Promise<void> {
  const sheets = getSheetsClient();

  // [1] 既存の dashboard を全消し
  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.google.sheetId,
    range: "dashboard",
  });

  // [2] 新しいデータを書き込む
  // values が空の場合は何もしない（dashboard が空の状態で残る）
  if (values.length === 0) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.google.sheetId,
    range: "dashboard!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

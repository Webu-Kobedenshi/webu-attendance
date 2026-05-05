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

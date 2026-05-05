import { google } from "googleapis";
import { readFileSync } from "node:fs";

// 設計意図:
// - Service Account 認証で Sheets API クライアントを作る最小構成
// - 読み取り → 書き込みの両方を試して権限が正しいか確認する
// - 環境変数経由で読むことで、後で GitHub Actions に移行しやすい構造にしておく

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const KEY_PATH = process.env.GOOGLE_SA_KEY_PATH ?? "./secrets/sa-key.json";

if (!SHEET_ID) {
  throw new Error("GOOGLE_SHEET_ID が未設定です");
}

async function main() {
  // Service Account のキーを読み込む
  const credentials = JSON.parse(readFileSync(KEY_PATH, "utf-8"));

  // 認証クライアントを作る
  // scopes は spreadsheets のみ（Drive までは要求しない最小権限）
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  // [テスト1] 読み取り: members シートのヘッダー行を取得
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID!,
    range: "members!A1:E1",
  });
  console.log("✅ 読み取り成功:", readRes.data.values);

  // [テスト2] 書き込み: raw_log シートにテスト行を1行追加
  // 後で消せるように、わかりやすい目印を入れておく
  const writeRes = await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID!,
    range: "raw_log!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          new Date().toISOString().slice(0, 10),
          "TEST_USER_ID",
          "テスト太郎",
          "test_taro",
          "出席",
          new Date().toISOString(),
        ],
      ],
    },
  });
  console.log("✅ 書き込み成功:", writeRes.data.updates?.updatedRange);
}

main().catch((err) => {
  console.error("❌ エラー:", err.message);
  process.exit(1);
}); 

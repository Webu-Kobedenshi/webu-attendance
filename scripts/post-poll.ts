// 設計意図:
// - workflow A のエントリポイント
// - 冪等性: 同日に既に Poll 投稿済みならスキップ
// - 失敗時はログに残してプロセスを 1 で終了（GitHub Actions が失敗を検知できる）

import { postAttendancePoll } from "../src/discord.js";
import {
  findActivityLogByDate,
  appendActivityLog,
} from "../src/sheets.js";
import { todayJST, nowJSTISO } from "../src/date.js";

async function main() {
  const today = todayJST();
  console.log(`[${today}] Poll 投稿処理を開始`);

  // 冪等性チェック: 同日に既に投稿済みなら何もしない
  const existing = await findActivityLogByDate(today);
  if (existing) {
    console.log(
      `既に投稿済みのためスキップ: message_id=${existing.messageId}, status=${existing.status}`,
    );
    return;
  }

  // Poll を投稿
  const question = `【${today}】本日の出欠を回答してください（19:00締切）`;
  const messageId = await postAttendancePoll(question);
  console.log(`Poll 投稿成功: message_id=${messageId}`);

  // activity_log に記録
  await appendActivityLog({
    date: today,
    messageId,
    postedAt: nowJSTISO(),
  });
  console.log(`activity_log に記録完了`);
}

main().catch((err) => {
  console.error("❌ エラー:", err.message);
  process.exit(1);
}); 

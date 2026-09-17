// 設計意図:
// - workflow B のエントリポイント
// - 冪等性: status === "collected" なら再集計をスキップ（手動で強制再実行したい場合は status を posted に戻せばよい）
// - active メンバー全員に対して 遅刻/欠席/就活/未回答 を判定し、raw_log に UPSERT
// - 100件超の投票があった場合は警告ログを出して人間に通知

import { getPollVoters } from "../src/discord.js";
import {
  findActivityLogByDate,
  getMembers,
  upsertRawLog,
  markActivityLogCollected,
  type RawLogRow,
  type AttendanceStatus,
} from "../src/sheets.js";
import { todayJST, nowJSTISO } from "../src/date.js";
import { shouldRunForActivityDate } from "../src/activity-schedule.js";
import { getAllRawLog, rewriteDashboard } from "../src/sheets.js";
import { buildDashboard } from "../src/dashboard.js";

// Poll の選択肢ID(workflow A での定義順)
// answers配列の順序通りに 1, 2, 3 が割り振られる
const ANSWER_ID_LATE = 1; // 遅刻 ⏰
const ANSWER_ID_ABSENT = 2; // 欠席 ❌
const ANSWER_ID_JOB_HUNTING = 3; // 就活 💼

async function main() {
  const today = todayJST();

  if (!shouldRunForActivityDate(today)) {
    console.log(`[${today}] 活動日ではないため定期集計をスキップ`);
    return;
  }

  console.log(`[${today}] 結果集計処理を開始`);

  // [1] activity_log から今日のレコードを取得
  const activity = await findActivityLogByDate(today);
  if (!activity) {
    throw new Error(
      `activity_log に ${today} のレコードがありません。workflow A が実行されていない可能性があります`,
    );
  }
  if (activity.status === "collected") {
    console.log(
      `既に集計済みのためスキップ: message_id=${activity.messageId}, collectedAt=${activity.collectedAt}`,
    );
    return;
  }
  console.log(`対象 Poll: message_id=${activity.messageId}`);

  // [2] Discord から投票者を取得
  const [lateResult, absentResult, jobHuntingResult] = await Promise.all([
    getPollVoters(activity.messageId, ANSWER_ID_LATE),
    getPollVoters(activity.messageId, ANSWER_ID_ABSENT),
    getPollVoters(activity.messageId, ANSWER_ID_JOB_HUNTING),
  ]);

  // 100件超チェック(要件通り、超えたら警告)
  if (lateResult.reachedLimit) {
    console.warn(
      `⚠️  「遅刻」投票が100件に達しています。実際にはそれ以上の投票がある可能性があります。`,
    );
  }
  if (absentResult.reachedLimit) {
    console.warn(
      `⚠️  「欠席」投票が100件に達しています。実際にはそれ以上の投票がある可能性があります。`,
    );
  }
  if (jobHuntingResult.reachedLimit) {
    console.warn(
      `⚠️  「就活」投票が100件に達しています。実際にはそれ以上の投票がある可能性があります。`,
    );
  }

  console.log(
    `投票結果: 遅刻=${lateResult.voters.length}件, 欠席=${absentResult.voters.length}件, 就活=${jobHuntingResult.voters.length}件`,
  );

  // [3] members シートからメンバー一覧を取得
  const members = await getMembers();
  console.log(`メンバー数: ${members.length}`);

  // [4] 投票者を Discord ID でマップ化(後で照合に使う)
  const lateMap = new Map(lateResult.voters.map((v) => [v.id, v]));
  const absentMap = new Map(absentResult.voters.map((v) => [v.id, v]));
  const jobHuntingMap = new Map(jobHuntingResult.voters.map((v) => [v.id, v]));

  // [5] active メンバー × 投票者で照合し、4値に分類
  const recordedAt = nowJSTISO();
  const rawLogRows: RawLogRow[] = [];

  for (const member of members) {
    let attendance: AttendanceStatus;
    let globalName = member.displayName; // フォールバック: members の表示名
    let username = "";

    if (lateMap.has(member.discordId)) {
      attendance = "遅刻";
      const voter = lateMap.get(member.discordId)!;
      globalName = voter.globalName;
      username = voter.username;
    } else if (absentMap.has(member.discordId)) {
      attendance = "欠席";
      const voter = absentMap.get(member.discordId)!;
      globalName = voter.globalName;
      username = voter.username;
    } else if (jobHuntingMap.has(member.discordId)) {
      attendance = "就活";
      const voter = jobHuntingMap.get(member.discordId)!;
      globalName = voter.globalName;
      username = voter.username;
    } else {
      attendance = "未回答";
      // 投票していない場合は Discord から取得した名前情報がないので
      // members シートの表示名をそのまま使う(username は空文字)
    }

    rawLogRows.push({
      date: today,
      discordId: member.discordId,
      globalName,
      username,
      attendance,
      recordedAt,
    });
  }

  // 集計サマリーをログに出す(運用時のヘルスチェック用)
  const summary = {
    遅刻: rawLogRows.filter((r) => r.attendance === "遅刻").length,
    欠席: rawLogRows.filter((r) => r.attendance === "欠席").length,
    就活: rawLogRows.filter((r) => r.attendance === "就活").length,
    未回答: rawLogRows.filter((r) => r.attendance === "未回答").length,
  };
  console.log(`集計サマリー: ${JSON.stringify(summary)}`);

  // [6] raw_log に UPSERT
  const upsertResult = await upsertRawLog(rawLogRows);
  console.log(
    `raw_log 書き込み完了: 更新=${upsertResult.updated}件, 追加=${upsertResult.appended}件`,
  );

  // [7] activity_log を collected に更新
  await markActivityLogCollected({ date: today, collectedAt: recordedAt });
  console.log(`activity_log を collected に更新`);

  // [8] dashboard シートを更新
  // 設計意図: raw_log の最新状態で dashboard を再生成する
  console.log("dashboard を更新中...");
  const allRawLog = await getAllRawLog();
  const allMembers = await getMembers();
  const dashboardData = buildDashboard(allRawLog, allMembers);
  await rewriteDashboard(dashboardData);
  console.log(`dashboard 更新完了: ${dashboardData.length - 1}行 × ${dashboardData[0]?.length  ?? 0}列`);
}

main().catch((err) => {
  console.error("❌ エラー:", err.message);
  process.exit(1);
}); 

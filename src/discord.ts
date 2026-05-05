// 設計意図:
// - Discord REST API を fetch で直叩き（test-discord.ts と同じ方針）
// - Poll 投稿の最小実装を関数化し、後で workflow B でも使える結果取得関数も追加可能に
// - User-Agent は Discord 推奨フォーマットを踏襲

import { config } from "./config.js";

const DISCORD_API = "https://discord.com/api/v10";

const HEADERS = {
  Authorization: `Bot ${config.discord.botToken}`,
  "User-Agent": "WeBuAttendanceBot (https://github.com/we-bu, 0.1.0)",
  "Content-Type": "application/json",
};

export type PollAnswer = { answer_id: number; text: string };

/**
 * 出欠用の Poll を投稿し、message_id を返す
 *
 * Poll の仕様:
 * - 質問: 「本日の出欠を回答してください」
 * - 選択肢: 出席 / 欠席（単一選択）
 * - 期限: 4時間（要件通り。15:00 投稿 → 19:00 締切で 19:05 集計）
 *
 * @param question 質問文（日付などを含めるとログで識別しやすい）
 * @returns 投稿した message の ID
 */
export async function postAttendancePoll(question: string): Promise<string> {
  const body = {
    poll: {
      question: { text: question },
      answers: [
        { poll_media: { text: "出席 ✅" } },
        { poll_media: { text: "欠席 ❌" } },
      ],
      duration: 4, // 単位は時間
      allow_multiselect: false,
      layout_type: 1, // DEFAULT
    },
  };

  const res = await fetch(
    `${DISCORD_API}/channels/${config.discord.channelId}/messages`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Poll 投稿失敗: ${res.status} ${errorBody}`);
  }

  const message = await res.json();
  return message.id;
}

export type PollVoter = {
  id: string;          // Discord ID
  username: string;    // username（@xxxx）
  globalName: string;  // 表示名（global_name）、未設定なら username にフォールバック
};

/**
 * Poll の特定の選択肢に投票したユーザー一覧を取得
 *
 * 設計意図:
 * - limit=100 で固定（要件通り、超えたら呼び出し側でエラー）
 * - 100件取得 + after なしの場合: 投票が100件以下と判定可能
 * - 100件取得できた場合: 「101件目があるかもしれない」状態なので、
 *   呼び出し側で警告を出す
 *
 * @param messageId Poll の message ID
 * @param answerId 選択肢の ID（1: 出席, 2: 欠席）
 */
export async function getPollVoters(
  messageId: string,
  answerId: number,
): Promise<{ voters: PollVoter[]; reachedLimit: boolean }> {
  const url = new URL(
    `${DISCORD_API}/channels/${config.discord.channelId}/polls/${messageId}/answers/${answerId}`,
  );
  url.searchParams.set("limit", "100");

  const res = await fetch(url, { headers: HEADERS });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(
      `Poll 投票者取得失敗 (answer_id=${answerId}): ${res.status} ${errorBody}`,
    );
  }

  const data = await res.json();
  // レスポンス形式: { users: [{ id, username, global_name, ... }, ...] }
  const users = data.users ?? [];

  const voters: PollVoter[] = users.map((u: any) => ({
    id: u.id,
    username: u.username ?? "",
    globalName: u.global_name ?? u.username ?? "",
  }));

  return {
    voters,
    reachedLimit: voters.length >= 100,
  };
}

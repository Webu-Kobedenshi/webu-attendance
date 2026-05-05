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
      duration: 8, // 単位は時間
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

export type GuildMember = {
  discordId: string;
  displayName: string;  // nick > global_name > username の優先順
  roles: string[];      // ロール名の配列(@everyone は除外済み)
  joinedAt: string;     // ISO timestamp
};

/**
 * Guild の全メンバーを取得する(Bot は除外、ロール ID を名前に解決済み)
 *
 * 設計意図:
 * - 1リクエスト最大1000件のため、`after` で簡易ページング
 * - ロール ID → 名前は別エンドポイントで取って解決する
 * - Bot ユーザー(`user.bot === true`)はクラブメンバーではないので除外
 * - 表示名は Discord クライアント上の見え方に合わせ nick > global_name > username
 *
 * 必要な権限:
 * - Bot に Server Members Intent が必要(Developer Portal で有効化)
 */
export async function getGuildMembers(): Promise<GuildMember[]> {
  // [1] ロール ID → 名前のマップを作る
  const rolesRes = await fetch(
    `${DISCORD_API}/guilds/${config.discord.guildId}/roles`,
    { headers: HEADERS },
  );
  if (!rolesRes.ok) {
    const errorBody = await rolesRes.text();
    throw new Error(`ロール一覧取得失敗: ${rolesRes.status} ${errorBody}`);
  }
  const rolesData = (await rolesRes.json()) as { id: string; name: string }[];
  const roleNameById = new Map<string, string>();
  for (const r of rolesData) {
    roleNameById.set(r.id, r.name);
  }

  // [2] メンバーをページング取得
  const result: GuildMember[] = [];
  const limit = 1000;
  let after: string | undefined = undefined;

  while (true) {
    const url = new URL(
      `${DISCORD_API}/guilds/${config.discord.guildId}/members`,
    );
    url.searchParams.set("limit", String(limit));
    if (after) url.searchParams.set("after", after);

    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`メンバー一覧取得失敗: ${res.status} ${errorBody}`);
    }

    const members = (await res.json()) as Array<{
      user: {
        id: string;
        username: string;
        global_name: string | null;
        bot?: boolean;
      };
      nick: string | null;
      roles: string[];
      joined_at: string;
    }>;

    for (const m of members) {
      // Bot は除外
      if (m.user.bot) continue;

      // ロール ID を名前に解決(@everyone はそもそも roles 配列に含まれないが、
      // 念のため id === guildId のものは除外する)
      const roleNames = m.roles
        .map((id) => roleNameById.get(id))
        .filter((name): name is string => !!name && name !== "@everyone");

      result.push({
        discordId: m.user.id,
        displayName: m.nick ?? m.user.global_name ?? m.user.username,
        roles: roleNames,
        joinedAt: m.joined_at,
      });
    }

    // 取得件数が limit 未満なら最終ページ
    if (members.length < limit) break;
    after = members[members.length - 1]!.user.id;
  }

  return result;
}

// 設計意図:
// - 環境変数の読み込みと検証を1箇所に集約
// - 各スクリプトは config から値を取るだけにすることで、
//   GitHub Actions に移行する際もここだけ意識すればよくなる
// - 必須項目が欠けていたら起動時に即座に失敗させる（fail fast）

import { readFileSync } from "node:fs";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が未設定です`);
  }
  return value;
}

export const config = {
  discord: {
    botToken: requireEnv("DISCORD_BOT_TOKEN"),
    channelId: requireEnv("DISCORD_CHANNEL_ID"),
    // guildId は sync-members でのみ必要なので、起動時には検証しない
    // 使う側で requireGuildId() を呼ぶ
    get guildId(): string {
      return requireEnv("DISCORD_GUILD_ID");
    },
  },
  google: {
    sheetId: requireEnv("GOOGLE_SHEET_ID"),
    // GitHub Actions では JSON 文字列を直接渡せないことがあるので
    // パス指定 / JSON 文字列指定の両方に対応する
    credentials: loadGoogleCredentials(),
  },
};

function loadGoogleCredentials() {
  // 優先1: 環境変数に JSON 文字列が直接入っているケース（GitHub Actions 用）
  const json = process.env.GOOGLE_SA_KEY_JSON;
  if (json) {
    return JSON.parse(json);
  }

  // 優先2: ファイルパス指定（ローカル開発用）
  const path = process.env.GOOGLE_SA_KEY_PATH ?? "./secrets/sa-key.json";
  return JSON.parse(readFileSync(path, "utf-8"));
}

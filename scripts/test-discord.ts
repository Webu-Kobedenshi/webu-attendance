// 設計意図:
// - Discord REST API を fetch で直叩きする（discord.js は今回オーバースペック）
// - Bot Token と Channel ID を環境変数から読む（GitHub Actions Secrets と同じ流れ）
// - User-Agent ヘッダーを正しく設定する（GAS で詰まった経験を踏まえて明示）
// - まずは「チャンネル情報の取得」だけで疎通確認、Poll 投稿は別ステップ

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

if (!BOT_TOKEN || !CHANNEL_ID) {
  throw new Error("DISCORD_BOT_TOKEN または DISCORD_CHANNEL_ID が未設定です");
}

// Discord API のベース設定
// User-Agent は Discord 公式の推奨フォーマットに従う
// ref: https://discord.com/developers/docs/reference#user-agent
const DISCORD_API = "https://discord.com/api/v10";
const HEADERS = {
  Authorization: `Bot ${BOT_TOKEN}`,
  "User-Agent": "WeBuAttendanceBot (https://github.com/we-bu, 0.1.0)",
  "Content-Type": "application/json",
};

async function main() {
  // [テスト1] チャンネル情報の取得（読み取り権限の確認）
  const channelRes = await fetch(`${DISCORD_API}/channels/${CHANNEL_ID}`, {
    headers: HEADERS,
  });

  if (!channelRes.ok) {
    const body = await channelRes.text();
    throw new Error(`チャンネル取得失敗: ${channelRes.status} ${body}`);
  }

  const channel = await channelRes.json();
  console.log("✅ チャンネル取得成功:", {
    id: channel.id,
    name: channel.name,
    type: channel.type,
  });

  // [テスト2] Bot 自身の情報を取得（Token が有効かの確認）
  const meRes = await fetch(`${DISCORD_API}/users/@me`, { headers: HEADERS });
  if (!meRes.ok) {
    throw new Error(`Bot情報取得失敗: ${meRes.status}`);
  }
  const me = await meRes.json();
  console.log("✅ Bot 情報:", {
    username: me.username,
    id: me.id,
  });
}

main().catch((err) => {
  console.error("❌ エラー:", err.message);
  process.exit(1);
});

# webu-attendance

We部の活動日における出欠を、Discord Poll とスプレッドシートで自動集計するシステム。

## ローカル開発

### 必要な環境変数

`.env` を作成し、以下を設定する:

\`\`\`
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_ID=...
GOOGLE_SHEET_ID=...
GOOGLE_SA_KEY_PATH=./secrets/sa-key.json
\`\`\`

Service Account の JSON を `secrets/sa-key.json` に配置する(Git 管理外)。

### 実行

\`\`\`bash
npm install
node --env-file=.env --import tsx scripts/post-poll.ts    # Poll 投稿
node --env-file=.env --import tsx scripts/collect-poll.ts # 結果集計
\`\`\`

## アーキテクチャ

- **Discord REST API**: Bot Token 認証で Poll 投稿・結果取得
- **Google Sheets API**: Service Account 認証でシート操作
- **GitHub Actions**: cron + workflow_dispatch で自動・手動の両方に対応

スプレッドシートのシート構成:

- `members`: 部員一覧(手動メンテ)
- `activity_log`: 活動日と Poll の対応(自動記録)
- `raw_log`: 出欠の生データ(自動記録)
\`\`\`

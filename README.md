# webu-attendance

We部の活動日における出欠を、Discord Poll とスプレッドシートで自動集計するシステム。

## 目的

毎週の活動日に「誰が出席し、誰が出席していないか」を継続的に記録・可視化することで、運営が長期欠席メンバー（例: 3週連続で欠席している部員）を察知できるようにする。

集計されたデータは Google スプレッドシートに蓄積され、運営は **dashboard シートだけを見れば** 各メンバーの出欠傾向を把握できる。

## 全体像

```
木曜 09:00 JST  ─┐
                 │ GitHub Actions (cron) が Discord に Poll を自動投稿
                 │   → 「【YYYY-MM-DD】本日の出欠を回答してください」
                 │   → 選択肢: 出席 / 欠席（8時間後に Discord 側で自動締切）
                 │
木曜 17:05 JST  ─┤ GitHub Actions (cron) が Poll の投票結果を集計
                 │   → Discord から投票者リストを取得
                 │   → members シートと突合し「出席 / 欠席 / 未回答」を判定
                 │   → raw_log に追記、dashboard を再生成
                 │
任意のタイミング ─┘ 運営が dashboard シートを目視確認
                   → 連続欠席や未回答が続くメンバーを察知
```

## 運用

### 通常運用（毎週木曜）

何もしなくてよい。GitHub Actions の cron が自動で動く。
- `Post Attendance Poll`: 木曜 09:00 JST
- `Collect Attendance Poll`: 木曜 17:05 JST（Poll 締切の5分後）

### Discord サーバーのメンバーが変わったとき

新しい部員がサーバーに参加した／退会した／表示名やロールが変わったとき、運営が手動で **Sync Members** を実行する。
これをやらないと、新メンバーが集計対象に含まれない／退会者が `dashboard` に残り続ける。

手順:
1. GitHub の **Actions** タブを開く
2. 左サイドバーから **Sync Members** を選択
3. **Run workflow** ボタン → ブランチは `main` のまま → **Run workflow**

挙動: Discord Guild の最新状態で `members` シートを **全上書き**する。Bot は除外され、ロール未付与の人も載る（Discord 側が真実）。

### 不定期の活動日（夏休みのイベント等、木曜以外で活動するとき）

cron は木曜固定のままにしている。木曜以外で出欠を取りたい場合は、当日に運営が **手動で** Poll 投稿と集計を実行する。

朝（活動開始前後）:
1. **Actions** → **Post Attendance Poll** → **Run workflow**

夜（Poll 締切後）:
2. **Actions** → **Collect Attendance Poll** → **Run workflow**

冪等性は担保されているので二重実行しても安全:
- post-poll: 同日に既に投稿済みならスキップ
- collect-poll: 既に集計済みならスキップ（強制再集計したい場合は `activity_log` の `status` を `posted` に戻す）

### 出欠状況の確認

スプレッドシートの **dashboard シート** を開く。

- 行: 部員（チーム → 表示名でソート）
- 列: 活動日（左から古い順）
- セル: `○`=出席 / `×`=欠席 / `△`=未回答 / 空=記録なし

**注目すべきパターン**: 直近の数列で `×` や `△` が連続しているメンバー。例えば3週連続で `×` が並ぶ部員はチームに参加できていない可能性があり、運営からの声かけが必要かもしれない。

## スプレッドシート構成

| シート名 | 役割 | 更新タイミング |
|---|---|---|
| `members` | 部員一覧（Discord ID, 表示名, ロール, 参加日） | `sync-members` 実行時に**全上書き** |
| `activity_log` | 活動日 → Poll メッセージID と集計ステータスの対応 | `post-poll` で追記、`collect-poll` で `status` 更新 |
| `raw_log` | 日次の出欠生ログ（日付 × 部員 × 出欠ステータス） | `collect-poll` で UPSERT |
| `dashboard` | 運営が見る集計ビュー（横軸=日付、縦軸=部員） | `collect-poll` のたびに `raw_log` から再生成 |

運営が日常的に見るのは `dashboard` だけでよい。他のシートは内部状態。

## ローカル開発

### セットアップ

```bash
npm install
cp .env.example .env
# .env を編集して値を埋める
# Service Account の JSON を secrets/sa-key.json に配置(Git 管理外)
```

### 環境変数

| 変数 | 用途 |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord Bot の認証トークン |
| `DISCORD_CHANNEL_ID` | Poll を投稿するチャンネルID |
| `DISCORD_GUILD_ID` | `sync-members` 用。メンバー一覧を取る Guild ID |
| `GOOGLE_SHEET_ID` | スプレッドシートID |
| `GOOGLE_SA_KEY_PATH` | Service Account JSON のパス（ローカル用） |

GitHub Actions では `GOOGLE_SA_KEY_JSON` (中身そのもの) を Secrets に入れる。`DISCORD_CHANNEL_ID` / `DISCORD_GUILD_ID` は Variables。

### スクリプト

```bash
npm run post-poll      # Poll 投稿
npm run collect-poll   # 結果集計 + dashboard 再生成
npm run sync-members   # members シートを Discord と同期
npm run test-discord   # Discord API 疎通確認
npm run test-sheets    # Sheets API 疎通確認
```

## アーキテクチャ

- **Discord REST API**: Bot Token 認証で Poll 投稿・投票者取得・Guild メンバー取得
- **Google Sheets API**: Service Account 認証でシート読み書き
- **GitHub Actions**: `cron` で自動実行、`workflow_dispatch` で手動実行に対応

設計方針:
- **冪等性**: post-poll / collect-poll は二重実行しても壊れない（重複投稿・重複集計を `activity_log` の状態でガード）
- **責務の分離**: 集計ロジック (`src/dashboard.ts`) はシート操作を含まない純粋関数で、テスト容易性を確保
- **Discord 側を信頼**: メンバーマスタは Discord Guild が真実。`members` シートは派生データなので `sync-members` で全上書きする

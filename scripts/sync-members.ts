// 設計意図:
// - members シートを Discord Guild の状態で全上書きする手動ジョブ
// - 運営が GitHub Actions の workflow_dispatch から実行する想定
// - post-poll / collect-poll のクリティカルパスから切り離し、毎日は走らせない
// - Discord 側の状態が真実: 退会者は次回同期で消える、ロール未付与の人も載せる

import { getGuildMembers } from "../src/discord.js";
import { overwriteMembers, type Member } from "../src/sheets.js";

async function main() {
  console.log("Discord からメンバー一覧を取得中...");
  const guildMembers = await getGuildMembers();
  console.log(`取得件数: ${guildMembers.length}件 (Bot 除外済み)`);

  // 集計サマリーをログに出す(運用時のヘルスチェック用)
  const withRoles = guildMembers.filter((m) => m.roles.length > 0).length;
  const withoutRoles = guildMembers.length - withRoles;
  console.log(
    `内訳: ロールあり=${withRoles}件, ロール未付与=${withoutRoles}件`,
  );

  // ロール別の人数を出す(team1/team2/team3 がちゃんと取れているか確認できる)
  const roleCount = new Map<string, number>();
  for (const m of guildMembers) {
    for (const r of m.roles) {
      roleCount.set(r, (roleCount.get(r) ?? 0) + 1);
    }
  }
  const roleSummary = Array.from(roleCount.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name}=${n}`)
    .join(", ");
  console.log(`ロール別: ${roleSummary || "(なし)"}`);

  const members: Member[] = guildMembers.map((m) => ({
    discordId: m.discordId,
    displayName: m.displayName,
    roles: m.roles,
    joinedAt: m.joinedAt,
  }));

  console.log("members シートを上書き中...");
  await overwriteMembers(members);
  console.log(`✅ members シート更新完了: ${members.length}件`);
}

main().catch((err) => {
  console.error("❌ エラー:", err.message);
  process.exit(1);
});

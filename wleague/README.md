# Wリーグ FUTURE 分析（内部スタッフ用）

公開URL: https://kimura-boop.github.io/basketball-report/wleague/

- `index.html` … 順位・最新の結果・今後の試合
- `team.html?id=<team_id>` … チームのシーズン傾向（指標推移、選手、出場時間、ラインナップ通算）
- `game.html?id=<play_schedule_id>` … 1試合のレポート

## データの流れ

ページを開くたびに WJBL 公式サイトの公開データ（`api.wjbl.01core.app`）を読み込み、ブラウザ上で集計します。
試合終了直後（公式記録の確定前）から「速報」として表示し、確定すると自動で通常表示に切り替わります。保存データは確定した試合のみです。

予備として、GitHub Actions（`.github/workflows/wleague-cache.yml`）が毎週月曜 3:00（JST）に
終了試合のデータを `wleague/data/` に保存します。個別の試合はこの保存データを優先して読み込みます。
Actions タブの「Run workflow」から手動実行もできます。

## チーム ID

| ID | チーム |
|---|---|
| 232 | 広島イーグレッツ |
| 18 | 三菱電機コアラーズ |
| 36 | 新潟アルビレックスBBラビッツ |
| 16 | 山梨クィーンビーズ |
| 204 | プレステージインターナショナル アランマーレ |
| 14 | 東京羽田ヴィッキーズ |
| 357 | SMBC TOKYO SOLUA |

シーズンが変わったら `assets/core.js` と `scripts/wleague-cache.mjs` の `seasonId`・`months`・チーム一覧を更新します。
検索エンジンには載らない設定（noindex）ですが、URLを知っていれば誰でも閲覧できます。

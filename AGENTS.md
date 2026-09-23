# LEVELIA_GAME

- 既存のLEVELIA Bot（KARUMA）とは独立したリポジトリ。
- TypeScript / ESM / discord.js v14 / MySQL / RailwayのWorker構成。
- 現段階は開発基盤のみ。ゲーム仕様は `docs/yubisuma.md` を参照する。
- ユーザーから設置指示があるまでは、Discordへのパネル投稿を行わない。
- 未確定のゲームルール、賭け金、報酬、残高共有を推測で実装しない。
- トークンやDB接続情報は環境変数で管理し、既存Botから無断で流用しない。
- Discordの運用IDを導入する場合は専用の設定ファイルにまとめる。
- コマンド登録やパネル投稿は、Bot起動から分離した明示的な操作にする。
- ゲーム状態は再起動を考慮してMySQLへ保存する設計とし、DB処理前に適切なinteraction応答を行う。
- コミット前に `npm run check` と `npm run build` を実行する。

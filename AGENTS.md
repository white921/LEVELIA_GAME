# LEVELIA_GAME

- 既存のLEVELIA Bot（KARUMA）とは独立したリポジトリ。
- TypeScript / ESM / discord.js v14 / MySQL / RailwayのWorker構成。
- フォルダ構成はKARUMAの役割別・機能別の配置に合わせる。詳細は `src/README.md`。
- `command` / `handler` / `panel` / `service` / `constant` / `type` / `util` / `sql` のうち必要な層だけを作り、各層の下を機能別に分ける。実行基盤は `system`、全体共通は `shared`。
- 固定設定は `constant/<機能>`、interfaceと名前付きtypeは `type/<機能>`。型は `import type` で参照し、可変な実行時状態は使用する処理内で管理する。
- 一括再export用の `index.ts` は作らず、対象ファイルから直接importする。
- CPU対戦・2人対戦の指スマを実装。ゲーム仕様は `docs/yubisuma.md` を参照する。
- ユーザーが指スマスレッド `1552248958443716688` への設置を許可済み。別のチャンネルへの投稿は指示を確認する。
- 未確定のゲームルール、賭け金、報酬、残高共有を推測で実装しない。
- トークンやDB接続情報は環境変数で管理し、既存Botから無断で流用しない。
- `GUILD_ID` はRailwayの環境変数で設定し、`loadConfig()` の `guildId` から参照する。コードに固定値を書かない。ローカル開発では `.env` に設定する。
- その他のDiscordの運用IDを導入する場合は専用の設定ファイルにまとめる。
- コマンド登録やパネル投稿は、Bot起動から分離した明示的な操作にする。
- ゲーム状態は再起動を考慮してMySQLへ保存する設計とし、DB処理前に適切なinteraction応答を行う。
- コミット前に `npm run check` と `npm run build` を実行する。
- ゲーム変更時は `npm test` を実行する。DBの同時操作・再起動復帰は実MySQLテストでも検証する。
- ゲーム更新は `YubisumaStore.transact` のトランザクション内で行う。入力値を公開パネルやログに出さず、両者確定後だけ結果を表示する。
- 新Bot用のDBテーブルは `levelia_game_` 接頭辞を使う。`accounts` は残高表示が有効な場合の読み取り専用とし、賭け金・報酬を追加しない。

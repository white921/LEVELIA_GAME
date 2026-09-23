# LEVELIA_GAME

LEVELIA向けのDiscordゲームBot。既存のLEVELIA Botとは独立したリポジトリで管理します。
最初のゲームとして、CPU対戦・2人対戦に対応する指スマを予定しています。

現時点は開発基盤のみです。ゲーム機能はまだ遊べません。Discordへのパネル設置、Botの本番起動、Railwayへのデプロイは未実施です。

## 構成

- Node.js 22 / TypeScript / ESM
- discord.js v14
- MySQL（mysql2）
- Railwayの常駐Worker（HTTPサーバー不要）

`package.json` の `private: true` はnpmへの誤公開を防ぐ設定です。GitHubリポジトリのPublic設定とは独立しています。

## 開発準備

```sh
nvm use
npm ci
cp .env.example .env
npm run check
npm run build
```

`.env` はGit管理から除外しています。接続確認を行う段階で、専用のDiscordアプリとMySQLの値を設定してください。

| 変数 | 内容 |
| --- | --- |
| `DISCORD_TOKEN` | LEVELIA_GAME用のBotトークン |
| `MYSQL_URL` | 接続先DB名を含む `mysql://` 接続URL |

```sh
npm run dev
# またはビルド後に起動
npm start
```

起動するとMySQLに `SELECT 1` を実行してからDiscord Gatewayへ接続します。DBテーブル作成、コマンド登録、パネル投稿は行いません。
現在は `Guilds` intentのみを使用します。

## 指スマとパネル

詳細は [仕様メモ](docs/yubisuma.md) を参照してください。
入口には「プレイ開始」「ルール説明」「残高確認」を配置し、LEVELIAのカジノカテゴリー内のテキストチャンネルへの設置を予定しています。

スラッシュコマンドは未定義です。登録スクリプトもまだありません。パネル設置用コマンドを追加する段階で、定義・登録スクリプト・必要権限を整備します。

## Railway（将来のデプロイ手順）

1. このリポジトリを接続し、常駐Workerとしてサービスを作成します。
2. `DISCORD_TOKEN` と `MYSQL_URL` をRailway Variablesに設定します。ローカルの `.env` はアップロードされません。
3. `railway.json` のビルド・起動コマンドを使用します。HTTP公開ドメインやHTTPヘルスチェックは不要です。
4. Deploy Logsで `MySQL connection verified` と `LEVELIA_GAME ready` を確認します。

初期段階ではWorkerを1レプリカで運用する想定です。残高を既存Botと共有するかどうかは未決定のため、既存の本番DBへ自動接続する設定は含めません。

## 検証・トラブルシューティング

- `npm run check`: TypeScriptの型チェック。
- `npm run build`: `dist/` へのビルド。CIでも両方を実行します。
- 起動直後に停止する場合は必須環境変数を確認してください。
- `Startup failed` の場合はエラーコードとRailway Deploy Logsを確認し、MySQLの到達性・DB名・Botトークンを確認してください。秘密値そのものはログへ出さないでください。
- パネルが出ないのは現段階では仕様です。起動時の自動投稿処理はありません。

## 公式資料

- [Discordのボタン・ユーザー選択メニュー](https://docs.discord.com/developers/components/reference)
- [Discordのインタラクション応答](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [RailwayのConfig as Code](https://docs.railway.com/config-as-code)

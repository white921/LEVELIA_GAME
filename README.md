# LEVELIA_GAME

LEVELIA向けのDiscordゲームBot。既存のLEVELIA Botとは独立したリポジトリで管理します。
CPU対戦・相互選択による2人対戦の指スマを実装しています。賭け金・報酬はありません。

## 構成

- Node.js 22 / TypeScript / ESM
- discord.js v14
- MySQL（mysql2）
- Railwayの常駐Worker（HTTPサーバー不要）

`package.json` の `private: true` はnpmへの誤公開を防ぐ設定です。GitHubリポジトリのPublic設定とは独立しています。

フォルダ構成はKARUMAに合わせ、役割別の層の下を機能別に分けます。
DB処理は `service/system`、固定設定は `constant/system`、型は `type/system`、補助処理は `util/system` に配置しています。
指スマは `service/yubisuma`、画面は `panel/yubisuma`、操作受付は `handler/interaction` に配置しています。詳細は [ソースコードの配置](src/README.md) を参照してください。

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
| `MYSQLHOST` / `MYSQLPORT` / `MYSQLUSER` / `MYSQLPASSWORD` / `MYSQL_DATABASE` | `MYSQL_URL` を使わない場合の接続設定。Railwayの個別変数形式に対応 |
| `GUILD_ID` | 対象のDiscordサーバーID。Railwayの環境変数で指定 |
| `BALANCE_MODE` | `unavailable`（既定）または `lia`。後者は同じDBの `accounts.wallet` を読み取り専用で表示 |

トークン、GUILD_ID、どちらかのDB接続設定が必須です。`GUILD_ID` はコードに固定せず文字列で扱います。ローカル開発では `.env` に設定してください。

```sh
npm run migrate
npm run dev
# またはビルド後に起動
npm start
```

起動時にDB接続と必要なテーブルを確認してからDiscord Gatewayへ接続します。テーブル作成は `npm run migrate` で明示的に行います。ゲーム状態はMySQLに保存し、再起動後も入力期限内の対戦に戻れます。
現在は `Guilds` intentのみを使用します。

## 指スマとパネル

詳細は [仕様メモ](docs/yubisuma.md) を参照してください。
設置先は指スマスレッド `1552248958443716688`。入口は「プレイ開始」「ルール説明」「残高確認」です。
1人プレイはCPU対戦、2人プレイは双方がUser Selectで相手を選ぶと成立します。
自分だけに見える選択メニューで入力し、両者の確定後にスレッドの対戦画面を更新します。

```sh
npm run panel:install
```

設置スクリプトはGUILD_IDとスレッド・権限を確認し、直近100件から同じBotの入口パネルを探して更新します。なければ新規送信し、読み戻して確認します。起動時の自動設置は行いません。
スラッシュコマンドは使用しないため、コマンド登録は不要です。
必要権限は View Channel / Send Messages in Threads / Embed Links / Read Message History。スレッドはロックされていない状態にしてください。

## Railway

1. このリポジトリを接続し、常駐Workerとしてサービスを作成します。
2. `DISCORD_TOKEN`・`GUILD_ID` とDB接続設定をRailway Variablesに設定します。ローカルの `.env` はアップロードされません。
3. `railway.json` のビルド・pre-deployマイグレーション・起動コマンドを使用します。HTTP公開ドメインやHTTPヘルスチェックは不要です。
4. Deploy Logsで `MySQL connection verified` と `LEVELIA_GAME ready` を確認します。

Workerは1レプリカで運用してください。使用するテーブルは `levelia_game_rooms` です。マイグレーションは再実行可能で、既存Botのテーブルを変更しません。
ゲーム開始・入力・期限切れ・降参を同じ部屋の行ロックで直列化します。終了した対戦は直近50件を保持し、入力期限は2分・相互選択待ちは5分です。

## 検証・トラブルシューティング

- `npm run check`: TypeScriptの型チェック。
- `npm run build`: `dist/` を削除してからビルド。CIでも両方を実行します。
- `npm test`: ルール・入力秘匿・interaction応答・設定のテスト。`TEST_MYSQL_SOCKET` または `TEST_MYSQL_PORT`（必要なら `TEST_MYSQL_PASSWORD`）を指定すると実MySQLの同時操作・ロールバック・永続化テストも実行します。CIではMySQLサービスを使って全テストを実行します。
- 起動直後に停止する場合は必須環境変数を確認してください。
- `Startup failed` の場合はエラーコードとRailway Deploy Logsを確認し、MySQLの到達性・DB名・Botトークンを確認してください。秘密値そのものはログへ出さないでください。
- `levelia_game_rooms` がない場合は `npm run migrate` を実行してください。
- 入力画面が古くなった場合は「対戦に戻る」で現在のラウンドを開き直してください。確定済み入力は変更できません。
- パネル設置は `npm run panel:install`。公開対戦画面の更新に失敗してもゲームの確定は取り消さず、30秒ごとの処理で再試行します。

## 公式資料

- [Discordのボタン・ユーザー選択メニュー](https://docs.discord.com/developers/components/reference)
- [Discordのインタラクション応答](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [RailwayのConfig as Code](https://docs.railway.com/config-as-code)

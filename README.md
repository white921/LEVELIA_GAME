# LEVELIA_GAME

LEVELIA向けのDiscordゲームBotとブラウザゲーム。既存のLEVELIA Botとは独立したリポジトリで管理します。
CPU対戦・相互選択による2人対戦の指スマと、Discord Activity化を見据えた1人用ハイアンドローを実装しています。賭け金・報酬はありません。

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

## ハイアンドロー（ブラウザ版）

`activity/` は既存Botから分離したVite / TypeScriptのWebゲームです。Discord Activity内ではEmbedded App SDKで本人を認証し、Activityサーバーが同じDBの `accounts.wallet` を読み取り専用で参照します。ブラウザへDB接続情報やDiscord Client Secretは渡しません。

```sh
npm run activity:dev
```

通常は `http://127.0.0.1:5173` で開けます。ルールと現在の実装範囲は [ハイアンドロー ブラウザ版](docs/high-low.md) を参照してください。

```sh
npm run activity:test
npm run activity:build
PORT=3000 npm run activity:start
```

本番用サーバーは `activity-dist/` を配信し、`0.0.0.0:$PORT` で待ち受ける。`PORT` の既定値は `3000`。Railwayのヘルスチェックには `/health` を指定できる。

## Railway

同じGitHubリポジトリから、Bot WorkerとActivity Webを別サービスとして作成する。

| サービス | Build Command | Pre-deploy Command | Start Command | Public Domain |
| --- | --- | --- | --- | --- |
| Bot Worker | `npm ci && npm run build` | `npm run migrate` | `npm start` | 不要 |
| Activity Web | `npm ci && npm run activity:build` | なし | `npm run activity:start` | 必要 |

Bot Workerでは `DISCORD_TOKEN`・`GUILD_ID` とDB接続設定をRailway Variablesに設定する。残高確認は同じDBの `accounts.wallet` を常に読み取り専用で参照する。Build・Pre-deploy・Start Commandは、共有設定ファイルではなく上表のとおり各サービスへ個別に設定する。

Activity WebではVariable `PORT=3000` を設定し、Public NetworkingのTarget Portにも `3000` を指定する。Healthcheck Pathは `/health`。発行された `*.up.railway.app` のホスト名を、Discord Developer PortalのActivities → URL MappingsでPrefix `/` に割り当てる。

Activity Webには次のVariableも設定する。Botの `DISCORD_TOKEN` はActivityへ設定しない。

| 変数 | 内容 |
| --- | --- |
| `DISCORD_CLIENT_ID` | Developer PortalのApplication ID（公開情報） |
| `DISCORD_CLIENT_SECRET` | OAuth2ページのClient Secret（Activityサーバーだけで使用） |
| `MYSQL_URL` | Railway MySQLサービスの接続URL参照。`accounts.wallet`の読み取りに使用 |

Activityは `identify` scopeだけを要求する。ブラウザから渡されたユーザーIDは信用せず、残高取得のたびにBearer tokenをDiscord APIの `/users/@me` で検証して得たIDを使う。

Bot WorkerのDeploy Logsでは `MySQL connection verified` と `LEVELIA_GAME ready`、Activity Webでは `LEVELIA_GAME Activity listening on 0.0.0.0:3000` を確認する。

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

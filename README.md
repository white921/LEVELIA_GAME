# LEVELIA_GAME

LEVELIA向けのDiscord Activityゲーム集です。React / TypeScript / Motionで画面と演出を実装し、Viteでビルドします。現在はLIAを賭ける1人用ハイアンドローを公開しています。

## 構成

```text
activity/
├── index.html                 # ViteのHTML入口
├── src/
│   ├── main.tsx              # React起動
│   ├── App.tsx               # ロビーと画面遷移
│   ├── components/           # 共通UI
│   ├── discord/              # Embedded App SDK連携
│   └── games/high-low/       # ハイアンドローのUI・ルール
├── server.mjs                # 静的配信とAPIのHTTPサーバー
├── server/                   # OAuth・本人確認・ゲーム・残高取引
├── sql/                      # Activity用DBマイグレーション
├── test/                     # ブラウザ側の純粋ロジックテスト
└── test-server/              # APIテスト
```

Discord Activityの抽選・勝敗・賭け金・配当はサーバーを正とします。Discord APIが返した本人のIDだけを使用し、ブラウザが申告したユーザーIDやゲーム結果は信用しません。通常ブラウザでは画面確認だけを行い、ゲームはDiscord Activity内から実際のLIAを使ってプレイします。ブラウザへMySQL接続情報やDiscord Client Secretは渡しません。

## 開発

```sh
nvm use
npm ci
cp .env.example .env
npm run migrate
npm run dev
```

通常ブラウザでは `http://127.0.0.1:5173` でプレビューできます。Discord認証と残高表示はDiscord Activity内でのみ動作します。

## コマンド

| コマンド | 用途 |
| --- | --- |
| `npm run dev` | Vite開発サーバー |
| `npm run check` | TypeScript型チェック |
| `npm test` | ゲームルール・画面遷移・APIテスト |
| `npm run build` | `activity-dist/`へ本番ビルド |
| `npm run migrate` | ハイアンドロー用テーブルを作成 |
| `npm start` | 本番HTTPサーバー |

既存のRailway設定との互換性のため、`activity:dev`、`activity:check`、`activity:test`、`activity:build`、`activity:start`も同じ処理の別名として残しています。

## 環境変数

| 変数 | 内容 |
| --- | --- |
| `PORT` | HTTPサーバーのポート。既定値は`3000` |
| `DISCORD_CLIENT_ID` | Developer PortalのApplication ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 Client Secret。サーバーだけで使用 |
| `MYSQL_URL` | ゲーム状態、`accounts.wallet`、取引履歴に使用するMySQL URL |
| `MYSQLHOST` / `MYSQLPORT` / `MYSQLUSER` / `MYSQLPASSWORD` / `MYSQL_DATABASE` | `MYSQL_URL`を使わない場合の接続設定 |

## Railway

| Build Command | Start Command | Public Domain | Healthcheck |
| --- | --- | --- | --- |
| `npm ci && npm run build` | `npm start` | 必要 | `/health` |

`PORT=3000`を設定し、Public NetworkingのTarget Portも`3000`にします。発行されたホスト名をDiscord Developer PortalのActivities → URL MappingsでPrefix `/` に割り当てます。

Pre-deploy Commandには`npm run migrate`を設定します。マイグレーションは専用のゲーム・配当設定テーブルを更新し、口座の作成やユーザー情報変更は行いません。履歴表示専用の`LEVELIA Game`口座（`1552246348756025344`）は事前に存在する必要があります。配当の取引履歴を表示するには、KARUMA側にも`high_low_bet`と`high_low_payout`の履歴定義が必要です。管理3ロール専用の目標還元率コマンドと配当計算は[ハイロー仕様](docs/high-low.md)を参照してください。

Activityは`identify` scopeだけを要求します。残高取得時はブラウザが申告したユーザーIDを信用せず、Bearer tokenをDiscord APIの `/users/@me` で検証します。

ルールと現在の実装範囲は [ハイアンドロー仕様](docs/high-low.md) を参照してください。

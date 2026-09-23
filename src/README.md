# ソースコードの配置

KARUMAの `src/README.md` にある役割別・機能別の配置を採用する。
同じ機能には各層で共通のフォルダ名を使い、実行基盤は `system`、全体共通の定義は `shared` に置く。
実装が必要な層だけにフォルダを作る。

| 層 | 役割 | 配置例 |
| --- | --- | --- |
| `command` | スラッシュコマンドの定義と入口 | `command/panel/panel.ts` |
| `handler` | イベント・操作の振り分け | `handler/interaction/userSelectHandler.ts` |
| `panel` | 常設パネルの表示・ボタン構築・投稿・設置 | `panel/yubisuma/yubisumaPanelService.ts` |
| `service` | マッチング・ゲーム進行・DB接続などの処理 | `service/yubisuma/yubisumaService.ts` |
| `constant` | 固定設定・文言・識別子・タイムアウト | `constant/yubisuma/yubisuma.ts` |
| `type` | interface・名前付きtype・DB取得結果の型 | `type/yubisuma/yubisuma.ts` |
| `util` | 入力チェックや補助処理 | `util/system/runtimeConfig.ts` |
| `sql` | 新規DB定義とマイグレーション | `sql/createTable.sql` |

指スマの処理は `service/yubisuma`、画面構築は `panel/yubisuma`、操作受付は `handler/interaction/yubisumaHandler.ts`、期限管理・投稿再試行は `handler/system` に置く。コマンドは使わず、パネル設置の入口は `installPanel.ts`、DBマイグレーションの入口は `migrate.ts` とする。

## 実行基盤の配置

```text
src/
├── index.ts                       # Bot起動・終了とDiscordイベント接続
├── constant/system/
│   ├── database.ts                # MySQLの固定設定
│   └── runtime.ts                 # 終了待機時間
├── service/system/
│   └── dbService.ts               # MySQL接続プール生成
├── type/system/
│   └── runtimeConfig.ts           # 環境設定の型
└── util/system/
    ├── error.ts                   # ログ用エラーコード抽出
    └── runtimeConfig.ts           # 環境変数の検証
```

## 配置ルール

- Botの入口は `index.ts`、コマンド登録を実装するときの入口は `registerCommands.ts` とする。
- ボタンや選択メニューの振り分けは `handler/interaction`、指スマの処理は `service/yubisuma` に置く。
- 常設パネルの描画・設置は `panel`、ゲーム進行中の処理とそれに必要な確認画面はサービス側で扱う。
- 固定値は `constant`、型は `type` に分け、型は `import type` で参照する。
- 接続プールやゲーム進行中の状態などの可変値は、使用する処理内で管理する。
- `GUILD_ID` はRailwayの環境変数（ローカルでは `.env`）で設定し、`loadConfig()` の `guildId` から文字列のまま参照する。
- その他のDiscordの運用IDを追加するときは `constant/shared` にまとめる。
- importは対象ファイルを直接指定し、一括再export用の `index.ts` は追加しない。
- ESMのため、TypeScriptソースのimportにも出力先の `.js` 拡張子を付ける。

移動後は呼び出し元とドキュメントを更新し、`npm run check` と `npm run build` で確認する。
ビルド時は `dist` を作り直し、移動前のJavaScriptが残らないようにする。

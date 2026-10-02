# LEVELIA_GAME

- 既存のLEVELIA Bot（KARUMA）とは独立したリポジトリ。
- React / TypeScript / Motion / ViteでDiscord Activity向けのWebゲームを実装する。
- 画面と状態管理はReact、UIアニメーションはMotion、単純なホバーや装飾はCSSを使う。
- ゲームごとのコードは `activity/src/games/<game>` に置き、ルールはReactから独立した純粋なTypeScriptとして保つ。
- Discord認証コード交換、本人確認、残高参照は `activity/server` で行い、Client SecretやDB接続情報をブラウザへ渡さない。
- 未確定のゲームルール、賭け金、報酬、残高共有を推測で実装しない。
- Client ID以外の秘密値とDB接続情報は環境変数で管理し、既存Botから無断で流用しない。
- ブラウザ内のスコアやゲーム状態は改変可能として扱う。ランキング、報酬、対戦結果に使う場合はサーバーを正とする。
- `accounts` の作成やユーザー情報変更は行わない。ハイアンドローの賭け金・配当だけは、ゲーム状態・専用台帳・`actions`履歴と同じDBトランザクションで残高へ反映する。
- `actions`ではLEVELIA GameユーザーID `1552246348756025344` を履歴上の相手として使うが、その口座残高は更新しない。
- Discord Activity内と通常ブラウザの両方で動作させる。`prefers-reduced-motion`を尊重する。
- コミット前に `npm run check`、`npm test`、`npm run build` を実行する。

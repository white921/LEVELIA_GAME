# ハイアンドロー ブラウザ版

更新日: 2026-09-30

## 現在の範囲

- ブラウザで動く1人用プロトタイプ。
- 52枚の通常トランプを1組使用し、ジョーカーは使わない。
- 現在のカードより次のカードが高いか低いかを予想する。
- Aを最大、2を最小とする。スート（マーク）に強弱はない。
- 同じ数字は引き分けとし、正解数と連勝数は変化しない。
- 正解で正解数と連勝数を1増やし、不正解で連勝数だけ0に戻す。
- 山札がなくなると終了する。最高連勝だけブラウザのローカルストレージに保存する。
- 賭け金、報酬、LIA、アカウント、DB、マルチプレイ、Discord Embedded App SDKは未接続。

## 起動

```sh
npm install
npm run activity:dev
```

表示されたローカルURLをブラウザで開く。通常は `http://127.0.0.1:5173`。

## 検証

```sh
npm run activity:test
npm run activity:build
PORT=3000 npm run activity:start
```

`activity-dist/` に静的ファイルが生成される。Discord Activity化する際は、HTTPSで配信するフロントエンドとしてこの成果物を使用し、Discord認証・ゲーム状態・乱数の最終決定はサーバー側へ移す。

RailwayではActivity WebサービスのBuild Commandを `npm ci && npm run activity:build`、Start Commandを `npm run activity:start` とする。VariableとPublic NetworkingのTarget Portをともに `3000`、Healthcheck Pathを `/health` に設定する。

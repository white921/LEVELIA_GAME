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
- Discord Activity内ではEmbedded App SDKの `identify` scopeで本人を認証する。
- 連携済みDiscord IDに対応する `accounts.wallet` をActivityサーバーから読み取り専用で表示する。口座の作成・更新は行わない。
- 賭け金、報酬、マルチプレイは未実装。

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

`activity-dist/` に静的ファイルが生成される。通常ブラウザではゲームをプレビューできるが、Discord認証と残高表示はDiscord Activity内でのみ動作する。

RailwayではActivity WebサービスのBuild Commandを `npm ci && npm run activity:build`、Start Commandを `npm run activity:start` とする。VariableとPublic NetworkingのTarget Portをともに `3000`、Healthcheck Pathを `/health` に設定する。

Activity WebのVariableには `DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`MYSQL_URL` も設定する。Client SecretとMySQL接続情報はサーバー内だけで使用し、Viteの公開環境変数にはしない。Bot用の `DISCORD_TOKEN` は不要。

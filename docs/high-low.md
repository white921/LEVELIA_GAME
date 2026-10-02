# ハイアンドロー ブラウザ版

更新日: 2026-10-02

## 現在の範囲

- React / TypeScript / Motionで動く1人用ゲーム。
- 52枚の通常トランプを1組使用し、ジョーカーは使わない。
- 現在のカードより次のカードが高いか低いかを予想する。
- Aを最大、2を最小とする。スート（マーク）に強弱はない。
- 同じ数字は引き分けとし、連勝数と精算倍率は変化しない。
- 正解で連勝数を1増やし、不正解は払い戻しなしでゲーム終了とする。
- 山札へカードを戻さず、残り枚数やランク内訳は画面に表示しない。
- Aまたは2が次の基準カードになった場合は、勝敗や連勝を増減させず次のカードまで自動で進める。
- 1〜4連勝では精算または次の予想を選べる。5連勝で6倍を強制精算し、6連勝以上は行わない。
- 賭け金は100・1,000・10,000 LIA。倍率は1連勝1.5倍、2連勝2倍、3連勝3倍、4連勝4倍、5連勝6倍。
- Discord Activity内ではEmbedded App SDKの `identify` scopeで本人を認証する。
- Discordで検証した本人の`accounts.wallet`だけを使用し、山札・勝敗・精算はActivityサーバーを正とする。
- 通常ブラウザは画面確認用とし、ゲーム結果は生成しない。実プレイはDiscord Activity内で行う。
- 切断から5分間は復帰できる。期限後は1勝以上なら現在倍率で自動精算し、0勝なら払い戻しなしで終了する。1ゲームの絶対期限は30分。
- 賭け金は残高から消滅し、配当は新規発行する。LEVELIA Gameの履歴用口座残高は変動させない。

## 安全性

- 1ユーザーにつき進行中ゲームは1件だけ。
- 変更APIは`requestId`で二重処理を防ぎ、`version`で古いタブからの操作を拒否する。
- 残高、ゲーム状態、専用台帳、`actions`履歴は同一DBトランザクションで確定する。
- シャッフル、運命改変、カード選択にはサーバーの暗号学的乱数を使う。
- 凍結口座とサブアカウントは新しいゲームを開始できない。
- 配当履歴は「LEVELIA Gameからの送金」と表示する。履歴上の相手IDは`1552246348756025344`。マイグレーション時に不足していれば口座を作成するが、既存残高とゲーム中の口座残高は変更しない。

## 起動

```sh
npm install
npm run migrate
npm run dev
```

表示されたローカルURLをブラウザで開く。通常は `http://127.0.0.1:5173`。

## 検証

```sh
npm run activity:test
npm run build
PORT=3000 npm start
```

`activity-dist/` に静的ファイルが生成される。通常ブラウザではゲームをプレビューできるが、Discord認証と残高表示はDiscord Activity内でのみ動作する。

RailwayではActivity WebサービスのBuild Commandを `npm ci && npm run activity:build`、Pre-deploy Commandを`npm run migrate`、Start Commandを `npm run activity:start` とする。VariableとPublic NetworkingのTarget Portをともに `3000`、Healthcheck Pathを `/health` に設定する。

Activity WebのVariableには `DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`MYSQL_URL` も設定する。Client SecretとMySQL接続情報はサーバー内だけで使用し、Viteの公開環境変数にはしない。

# 仮想残高による参加者テスト

`HIGH_LOW_WALLET_MODE=virtual` と `ACTIVITY_ACCESS_MODE=private` を併用し、
`ACTIVITY_ALLOWED_USER_IDS` に参加者のDiscord IDをカンマ区切りで指定する。
Discordが認証したIDを全ゲームAPIで確認し、ブラウザ申告IDは使用しない。

マイグレーション時、許可された参加者の実残高を専用仮想口座の初期値として一度だけコピーする。
実口座がない参加者や未精算の実残高ゲームがある場合は切り替えを停止する。
再デプロイや再接続で仮想残高をリセットしない。残高不足時も自動補充しない。

ゲーム開始、敗北、精算、5連勝、自動精算、再送の全経路で、
`levelia_game_high_low_virtual_wallets/hands/commands/ledger` のみを更新する。
実際の `accounts`、`actions`、通常ゲームの台帳には書き込まない。
最高連勝もテスト履歴で集計する。仮想残高から実残高への移行・交換機能はない。

倍率設定も `virtual_settings/virtual_setting_changes` に分離し、作成時点の倍率設定をコピーする。
管理コマンドは現在稼働しているモードの設定を変更する。
テスト中に設定を変更した場合、各ゲームの `payout_state` に開始時の係数と設定versionが残る。

画面の残高は「仮想残高（テスト）」と表示する。
ゲーム操作にはセッション応答に対応する `X-High-Low-Wallet-Mode` が必要で、
切り替え前の画面からの操作は409で拒否する。参加者は画面を開き直す。

## 収支確認

RailwayのActivityサービス内で以下を実行する（読み取り専用）。

```sh
node activity/server/reportHighLowVirtual.mjs
```

初期仮想残高、現在の仮想残高、純損益、ゲーム数、賭け金・配当合計、進行中ゲーム数、
台帳整合性、全員合計の純損益を返す。純損益には進行中ゲームの賭け金を含むが未精算配当は含めない。

明示的に承認されたテスト資金の補充は、仮想口座の加算と同じトランザクションで
`virtual_commands`に`action='test_credit'`、`hand_id=NULL`として記録する。
`response_json`には`amount`、加算前後の残高、理由を保存し、同じ`request_id`の再実行では二重加算しない。
初期残高を上書きせず、通常のゲーム台帳や配当には含めない。
収支報告の`test_credits`に分け、純損益は「現在残高 − 初期残高 − 補充額」で計算する。

## 結合テスト

`TEST_VIRTUAL_MYSQL_URL` には必ず破棄可能な専用DBを指定する。
テストはDB内のテーブルを作り直す。通常モード用 `TEST_MYSQL_URL` と同じDBを指定しない。
テストDB名は `levelia_*test`。ユーザーを作成・権限設定できる管理接続が必要。
実口座・実履歴への書き込みを許可しない専用テストユーザーで開始・精算・失敗時rollback・自動精算を検証する。

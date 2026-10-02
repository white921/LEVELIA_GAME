# 一時的なプレイ制限

Activity Webサービスの環境変数で制御する。

```text
ACTIVITY_ACCESS_MODE=private
ACTIVITY_ALLOWED_USER_IDS=649438093996195851
```

上記IDはシロ本人から提供されたDiscordユーザーID。ユーザー名・表示名・クライアントが送るIDでは照合しない。Discordの `/users/@me` が返した本人のIDを、認証コード交換時および認証が必要な全APIで検査する。既存のアクセストークンも制限対象。

- モード未設定は `private`。許可ID未設定は全員拒否。設定不正は起動時エラー。
- 許可対象外は403 `activity_access_denied`。ゲーム・残高DBへのアクセス前に拒否する。
- 規約・ポリシー・静的画面・ヘルスチェック・公開クライアント設定は閲覧可能。この制限はアプリの発見や画面表示を隠すものではない。
- 許可IDやモードは `/api/config` に出さない。
- バックグラウンドの期限切れ精算は維持する。制限前のゲームの賭け金・配当仕様を変えない。

再公開する際は、ユーザーの公開指示を受けたうえで `ACTIVITY_ACCESS_MODE=public` に変更し、デプロイ後の実行環境を確認する。DiscordのActivity有効化とDiscoveryは別設定。

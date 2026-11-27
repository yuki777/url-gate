# 例: AWS IAM Identity Center

新しくインストールすると、この例の行が最初から対象 URL に入っています。AWS access portal のセッションが残っていれば、`aws sso login` の認可画面で「Allow access」を押すだけで認証情報を取得できてしまうのを防ぎます。

設定ページに書けるのと同じ行だけでできているので、自由に書き換えられます。使わなければ、すべて消して保存できます。リージョンとサブドメインは任意です。

## 入っている行

消したあとで戻したいときは、次の行を設定ページの対象 URL の欄に貼り付けて保存します（[presets.js](../presets.js) と同じ内容です）。

```
# AWS IAM Identity Center: aws sso login の認可画面と、デバイスコードの確認画面
oidc.*.amazonaws.com/authorize
oidc.*.api.aws/authorize
device.sso.*.amazonaws.com

# AWS access portal。一覧画面（! の行）だけは Touch ID なしで開ける
*.awsapps.com/start
!*.awsapps.com/start
!*.awsapps.com/start#/
!*.awsapps.com/start#/?tab=accounts
!*.awsapps.com/start#/?tab=applications
!*.awsapps.com/start/
!*.awsapps.com/start/#/
!*.awsapps.com/start/#/?tab=accounts
!*.awsapps.com/start/#/?tab=applications
*.portal.*.app.aws
!*.portal.*.app.aws/
!*.portal.*.app.aws/#/
!*.portal.*.app.aws/#/?tab=accounts
!*.portal.*.app.aws/#/?tab=applications
!*.portal.*.app.aws/start
!*.portal.*.app.aws/start#/
!*.portal.*.app.aws/start#/?tab=accounts
!*.portal.*.app.aws/start#/?tab=applications
!*.portal.*.app.aws/start/
!*.portal.*.app.aws/start/#/
!*.portal.*.app.aws/start/#/?tab=accounts
!*.portal.*.app.aws/start/#/?tab=applications
*.*.portal.amazonaws.com
!*.*.portal.amazonaws.com/
!*.*.portal.amazonaws.com/#/
!*.*.portal.amazonaws.com/#/?tab=accounts
!*.*.portal.amazonaws.com/#/?tab=applications
!*.*.portal.amazonaws.com/start
!*.*.portal.amazonaws.com/start#/
!*.*.portal.amazonaws.com/start#/?tab=accounts
!*.*.portal.amazonaws.com/start#/?tab=applications
!*.*.portal.amazonaws.com/start/
!*.*.portal.amazonaws.com/start/#/
!*.*.portal.amazonaws.com/start/#/?tab=accounts
!*.*.portal.amazonaws.com/start/#/?tab=applications

# 認証情報を取り出す通信と、デバイスコードを承認する通信。画面を移動せずに呼べるので、通信も止める
all:portal.sso.*.amazonaws.com/federation/
all:portal.sso.*.api.aws/federation/
all:oidc.*.amazonaws.com/device_authorization/
all:oidc.*.api.aws/device_authorization/
```

## 開く前に必ず Touch ID を求める URL

- `oidc.*.amazonaws.com/authorize`（`aws sso login` の認可画面）
- `oidc.*.api.aws/authorize`
- `device.sso.*.amazonaws.com`（デバイスコードの確認画面）

## AWS access portal

- `*.awsapps.com/start`
- `*.portal.*.app.aws`
- `*.*.portal.amazonaws.com`

一覧画面（`/start/`、`/start/#/`、`/start/#/?tab=accounts`、`/start/#/?tab=applications`）だけは、例外の行で Touch ID なしで開けるようにしています。それ以外の画面（`/start/#/console` など）は Touch ID を求めます。

## 認証情報を取り出す通信

- `all:portal.sso.*.amazonaws.com/federation/`
- `all:portal.sso.*.api.aws/federation/`
- `all:oidc.*.amazonaws.com/device_authorization/`
- `all:oidc.*.api.aws/device_authorization/`

access portal がコンソールのサインイン URL やアクセスキーを取り出すときの通信と、デバイスコードを承認するときの通信です。画面を移動せずに呼べるので、Touch ID を通したタブ以外では通信そのものを止めます。行頭の `all:` の意味は [詳しい書き方](advanced.md) にあります。

一覧画面でアクセスキーを表示したいときは、[ツールバーの拡張のボタン](advanced.md#ツールバーのボタン)を押してそのタブを解除します。

## 0.3 までの版から更新した場合

0.3 までは、AWS の対象 URL が最初から有効でした。更新すると、それまでの設定（AWS の対象 URL と、追加した URL パターン）を同じ内容の行に移し替えるので、そのまま使えます。追加した URL パターンが AWS access portal の一覧画面と重なる場合は、その一覧画面の例外の行を入れません（0.3 までは、追加した URL パターンのほうが優先だったためです）。

## 0.4 から 0.5.3 までの版でインストールした場合

0.4 から 0.5.3 までは、新しくインストールすると対象 URL は空でした。更新しても、保存されている設定（空のままの場合を含む）は書き換えません。AWS の例を使うときは、[入っている行](#入っている行)を設定ページの対象 URL の欄に貼り付けて保存します。

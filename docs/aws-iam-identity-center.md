# Example: AWS IAM Identity Center

A fresh install starts with the lines of this example as its protected URLs. As long as an AWS access portal session is still there, credentials can be obtained just by pressing "Allow access" on the authorization page of `aws sso login`. These lines prevent that.

The example consists only of lines that anyone can write on the options page, so you can edit it freely. If you don't use it, delete everything and save. Any region and any subdomain match.

## Lines in the example

To bring the lines back after deleting them, paste the following into the protected URLs field on the options page and save (it is the same as [presets.js](../presets.js)).

```
# AWS IAM Identity Center: the authorization page of aws sso login and the device code confirmation page
oidc.*.amazonaws.com/authorize
oidc.*.api.aws/authorize
device.sso.*.amazonaws.com

# AWS access portal. Only the list screens (the ! lines) open without Touch ID
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

# Requests that fetch credentials or approve a device code. They can be called without a navigation, so requests are blocked too
all:portal.sso.*.amazonaws.com/federation/
all:portal.sso.*.api.aws/federation/
all:oidc.*.amazonaws.com/device_authorization/
all:oidc.*.api.aws/device_authorization/
```

## URLs that always require Touch ID before opening

- `oidc.*.amazonaws.com/authorize` (the authorization page of `aws sso login`)
- `oidc.*.api.aws/authorize`
- `device.sso.*.amazonaws.com` (the device code confirmation page)

## AWS access portal

- `*.awsapps.com/start`
- `*.portal.*.app.aws`
- `*.*.portal.amazonaws.com`

Only the list screens (`/start/`, `/start/#/`, `/start/#/?tab=accounts`, `/start/#/?tab=applications`) open without Touch ID, through the exception lines. Every other screen (such as `/start/#/console`) requires Touch ID.

## Requests that fetch credentials

- `all:portal.sso.*.amazonaws.com/federation/`
- `all:portal.sso.*.api.aws/federation/`
- `all:oidc.*.amazonaws.com/device_authorization/`
- `all:oidc.*.api.aws/device_authorization/`

These are the requests the access portal makes to get a console sign-in URL or access keys, and the requests that approve a device code. They can be called without a navigation, so the requests themselves are blocked in every tab that has not passed Touch ID. The meaning of the leading `all:` is explained in [Advanced syntax](advanced.md).

To show access keys on the list screen, press [the extension's toolbar button](advanced.md#the-toolbar-button) to unlock that tab.

## Updating from 0.3 or earlier

Up to 0.3 the AWS URLs were protected from the start. On update, the earlier settings (the AWS URLs and the URL patterns you added) are converted into equivalent lines, so they keep working. If a URL pattern you added overlaps the list screens of the AWS access portal, the exception lines for those list screens are left out (up to 0.3 the added URL pattern took priority).

## Installed with 0.4 to 0.5.3

From 0.4 to 0.5.3 a fresh install started with no protected URLs. Updating does not rewrite stored settings (including an empty list). To use the AWS example, paste the [lines in the example](#lines-in-the-example) into the protected URLs field on the options page and save.

## Comment lines from 0.5.6 or earlier

Up to 0.5.6 the comment lines of the example were written in Japanese. Updating does not rewrite stored settings, so if your settings contain those comments they stay as they are. They are only comments, and the protection is the same. To switch to the English comments, paste the [lines in the example](#lines-in-the-example) over them and save.

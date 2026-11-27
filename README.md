# URL Gate

A Chrome extension that asks for Touch ID before opening the URLs you choose.

An AI agent that can drive your browser can do important things just by pressing a button on an admin or authorization page, as long as a signed-in session is still there. URL Gate replaces a navigation to a protected URL with a gate page, and nothing goes further until a person passes Touch ID.

You write the protected URLs yourself on the options page. There is no service-specific logic. Lines for AWS IAM Identity Center (formerly AWS SSO) are included from the start as an example ([AWS IAM Identity Center example](docs/aws-iam-identity-center.md)). If you don't use it, delete the lines on the options page and save.

New here? The [setup guide](https://github.com/yuki777/url-gate/wiki/Getting-Started) in the wiki walks through installation and the first Touch ID registration with screenshots.

## How it works

1. A tab that tries to open a protected URL is redirected to the extension's gate page.
2. The gate page shows the Touch ID dialog as soon as it opens. Once you pass WebAuthn (`userVerification: required`, built-in authenticator only), that tab alone is unblocked for 2 minutes and continues to the original URL.
3. After 2 minutes, or when the tab is closed, the URL is blocked again.

If you close the dialog, press "Open with Touch ID" on the gate page to show it again. It is not shown automatically when you come back to the gate page with the back button or a reload. If the gate page opened in a background tab, the dialog appears when you switch to that tab.

The dialog also appears when an AI agent tries to open a protected URL. If you see a dialog you did not ask for, close it without approving. The gate page shows the URL that is about to be opened.

Besides the redirect, the same URLs are blocked with declarativeNetRequest rules (the extension API that blocks requests inside the browser). Even if the extension's own code is too late, no request leaves a tab that has not passed Touch ID.

The extension's toolbar button shows ✓ while the current tab is unlocked. Otherwise it shows how many requests URL Gate has blocked in the tab, if any. Pressing it unlocks the tab without reloading the page, for the cases where no gate appears on its own ([the toolbar button](docs/advanced.md#the-toolbar-button)).

## Protected URLs

Open the extension's "Details" → "Extension options", write one URL per line, and press "Save with Touch ID". Saving can also remove protection, so it requires Touch ID too (register Touch ID first).

```
# Ask for Touch ID before opening the admin pages
example.com/admin
*.internal.example.com

# Only the help page opens without Touch ID
!example.com/admin/help
```

### Kinds of lines

| Line | Meaning |
|---|---|
| `example.com/admin` | Protected URL. Touch ID is required before opening this page |
| `!example.com/admin/help` | Exception. Within the protected URLs, only this page opens without Touch ID |
| `# note` | Comment. Saved as is, along with blank lines |

### How to write URLs

- The scheme (`https://`) is optional. Both http and https are protected either way.
- `*` in the host matches part of a hostname. A leading `*.` also matches the host without a subdomain, so `*.example.com` matches both `example.com` and `a.b.example.com`.
- The path is a prefix match. `*` in the path matches any string. Without a path, every page on the host is protected. Case is ignored.
- Without a port, any port matches (`example.com:8443` matches only that port). The browser drops default ports (`:443`, `:80`) from URLs, so a line with a default port also matches the URL without it.
- A fragment (`#` and what follows) cannot be written in a protected URL. It is not part of the request URL, so block rules cannot stop it.
- Internationalized domain names and non-ASCII paths can be written as they are (they are normalized the way the browser does before comparing, and so is IPv4 shorthand such as `127.1`).
- Consecutive `*` are collapsed into one.
- Protected URLs and exceptions can total up to 1,000 lines (Chrome's limit on block rules).

### How to write exceptions

To keep the unprotected range from growing too wide, an exception (`!`) matches only the URL exactly as written.

- The path is an exact match and case-sensitive. Without a path, it means the top page (`/`) only.
- Use `*` to exclude several pages at once (`!example.com/docs/*`).
- A fragment is allowed. On a site where only the fragment changes within one page, this excludes specific screens (`!app.example.com/#/list`).
- Without a fragment, an exception matches only URLs that have none. Add `#*` to let in-page links through as well (`!example.com/docs/guide#*`).
- Screens that differ only in the fragment cannot be told apart by the request URL. A page that has an exception with a fragment can be loaded inside an iframe whatever its fragment.

URLs are parsed by `parseLine` in [config.js](config.js).

Everything above is about URLs that a person opens as a page. To also block requests made by scripts inside a page, see [Advanced syntax](docs/advanced.md).

## Install

You need Chrome 122 or later (or another Chromium-based browser) and a Mac with Touch ID. The [setup guide](https://github.com/yuki777/url-gate/wiki/Getting-Started) shows each step with screenshots.

1. Clone this repository, or download it as a zip and extract it.
2. Open `chrome://extensions` and turn on "Developer mode".
3. Press "Load unpacked" and choose this folder.
4. The options page opens after installation. Press "Register Touch ID" there (to open it later, go to the extension's "Details" → "Extension options").
5. The protected URLs start with the AWS IAM Identity Center example. On the same page, replace it with the URLs you want to protect and save.

To update, replace the files with the new ones and press the reload button for this extension on `chrome://extensions`.

If you open a protected URL before registering, the gate page shows "Register Touch ID and open". Pressing it registers, then verifies you with Touch ID, and continues to the original URL (Touch ID is requested twice, once to register and once to verify).

When you register, you can choose where the passkey is saved.

- **Chrome profile** (saved on this Mac): the key is kept only in this Chrome profile on this Mac and is used with Touch ID. It does not sync to other devices. Choose this if you are not sure.
- **1Password**: save it from the 1Password dialog that appears during registration. From then on 1Password performs the verification (whether it uses Touch ID depends on your 1Password settings), and the passkey syncs to your other devices with 1Password.

To change where the passkey is saved, register again on the options page. A registration made with 0.5.5 or earlier keeps working without registering again.

The passkey is registered under the name (RP ID) `url-gate.yuki777.github.io`. The name exists so that 1Password and similar tools can save the passkey. The host does not exist and is never contacted. `host_permissions` in `manifest.json` is there only to use this name as the RP ID.

## What it does not prevent

URL Gate only adds one confirmation step to actions in the browser. It does not prevent the following.

- Disabling or removing the extension, another profile, an incognito window (unless the extension is allowed there), or another browser
- Actions in the same tab within 2 minutes of unlocking. Relocking uses a browser alarm, so if the alarm is late the tab stays unlocked that much longer
- Requests to a protected URL from a script in a page that is already open (what is blocked is opening the page; to block requests too, see [Advanced syntax](docs/advanced.md))
- The brief moment right after the screen changes on a site that switches screens within one page (through the fragment or the History API), because the redirect happens after the change is detected
- Reading what is shown on a page you made an exception (in the AWS example, the account names, account IDs and role names on the access portal's list screen)
- Opening, inside an iframe, a page that has an exception with a fragment (the fragment is not part of the request URL)
- Rewriting the settings by operating the extension's pages directly, for example with developer tools
- Entering the Mac login password instead of Touch ID in the OS verification dialog
- Mechanisms that open pages without going through extension rules, such as an AI assistant built into the browser (not verified)
- Routes that do not use the browser (such as credentials or tokens that were already issued)

If you need a firm guarantee, combine URL Gate with settings on the service itself (shorter sessions, requiring MFA, narrower permissions).

## Files

| File | Role |
|---|---|
| `manifest.json` | The extension manifest. `key` is the public key that pins the extension ID |
| `config.js` | Parsing of the settings lines (protected URLs, exceptions), reading and writing settings, the unlock duration |
| `presets.js` | The example the protected URLs start with (AWS IAM Identity Center) |
| `background.js` | Registering block rules, redirecting to the gate page, verifying signatures, per-tab unlock, saving settings |
| `webauthn.js` | Touch ID registration, assertion requests, signature verification |
| `gate.html` / `gate.js` | The gate page |
| `options.html` / `options.js` | The options page (Touch ID registration, protected URLs) |
| `icons/` | Icons. `icon.svg` is the source; the PNGs are exported from it |
| `scripts/package.mjs` | Builds the zip for the Chrome Web Store in `dist/` (`node scripts/package.mjs`) |
| `docs/` | Advanced syntax, the AWS IAM Identity Center example, and the images used by the wiki |
| `test/` | Tests for parsing the settings lines (run with `node --test`) |

The extension makes no network requests of its own. The registered public key and credential ID, and the protected URL settings, are stored in `chrome.storage.local`. See the [privacy policy](PRIVACY.md) for details.

## Releases

Releases use [tagpr](https://github.com/Songmu/tagpr). A push to main creates a release PR that bumps `version` in `manifest.json` and updates `CHANGELOG.md`. Merging that release PR creates the tag and the GitHub Release, and attaches the zip for the Chrome Web Store (`url-gate-<version>.zip`) to the GitHub Release. The zip leaves out the files the extension does not need at runtime and the `key` in `manifest.json`. The default bump is a patch. Add a `tagpr:minor` / `tagpr:major` label to the release PR, or a `minor` / `major` label to a PR included in the release, to change it. Editing `version` in `manifest.json` directly on the release PR takes priority.

## License

[MIT](LICENSE)

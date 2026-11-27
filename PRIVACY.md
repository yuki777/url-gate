# Privacy Policy

Last updated: 2026-11-27

URL Gate does not collect any user data and makes no network requests of its own.

- **Stored locally on your device** (`chrome.storage.local`)
  - The protected URL and exception lines you write on the options page
  - The public key and credential ID created when you register Touch ID (WebAuthn)
- **Used transiently**
  - The URL being opened, only to decide on your device whether it matches a protected URL. It is neither stored nor transmitted.
  - Per-tab unlock expiry and the verification challenge (`chrome.storage.session`, cleared when the browser closes)
- **Never handled**
  - Biometric data such as fingerprints. User verification is performed by the OS and the browser; the extension only receives a signed result.
  - Browsing history logs, page content, or anything you type
- No data is sent, sold, or shared with anyone, including the developer. There is no analytics or tracking.
- The permission for `url-gate.yuki777.github.io` is used only as the name the passkey is registered under (the RP ID). That host does not exist, and the extension never contacts it.
- If you choose a password manager such as 1Password as the place to save the passkey, that password manager stores and syncs the passkey.
- Removing the extension deletes all data the extension stored.

For questions, please open an issue on [GitHub](https://github.com/yuki777/url-gate/issues).

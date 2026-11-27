// The example that the protected URLs start with on a fresh install (DEFAULT_SETTINGS in config.js).
// It holds only the same kind of lines anyone can write on the options page; there is no service-specific logic.

// The list screens of the AWS access portal. Only these open without Touch ID.
const AWS_PORTAL_LIST_FRAGMENTS = ['', '#/', '#/?tab=accounts', '#/?tab=applications'];
const awsPortalListScreens = (host, paths) =>
  paths.flatMap((path) => AWS_PORTAL_LIST_FRAGMENTS.map((fragment) => `!${host}${path}${fragment}`));

// AWS IAM Identity Center (formerly AWS SSO). Any region and any subdomain.
export const AWS_IAM_IDENTITY_CENTER = {
  lines: [
    '# AWS IAM Identity Center: the authorization page of aws sso login and the device code confirmation page',
    'oidc.*.amazonaws.com/authorize',
    'oidc.*.api.aws/authorize',
    'device.sso.*.amazonaws.com',
    '',
    '# AWS access portal. Only the list screens (the ! lines) open without Touch ID',
    '*.awsapps.com/start',
    ...awsPortalListScreens('*.awsapps.com', ['/start', '/start/']),
    '*.portal.*.app.aws',
    ...awsPortalListScreens('*.portal.*.app.aws', ['/', '/start', '/start/']),
    '*.*.portal.amazonaws.com',
    ...awsPortalListScreens('*.*.portal.amazonaws.com', ['/', '/start', '/start/']),
    '',
    '# Requests that fetch credentials or approve a device code. They can be called without a navigation, so requests are blocked too',
    'all:portal.sso.*.amazonaws.com/federation/',
    'all:portal.sso.*.api.aws/federation/',
    'all:oidc.*.amazonaws.com/device_authorization/',
    'all:oidc.*.api.aws/device_authorization/',
  ],
};

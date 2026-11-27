// Run: node --test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_SETTINGS,
  buildRules,
  convertLegacySettings,
  initializeSettings,
  isGatedUrl,
  isUnlockableUrl,
  loadSettings,
  parseLine,
  parseLines,
} from '../config.js';
import { AWS_IAM_IDENTITY_CENTER } from '../presets.js';

// Stands in for chrome.storage.local. initial is what is already stored.
function mockStorage(context, initial) {
  const items = { ...initial };
  const local = {
    get: async (key) => (key in items ? { [key]: items[key] } : {}),
    set: async (values) => void Object.assign(items, values),
  };
  globalThis.chrome = { storage: { local } };
  context.after(() => delete globalThis.chrome);
  return items;
}

const rulesOf = (...lines) => buildRules({ lines });
const blockedByNetwork = (rules, url, { isFrame }) => {
  const networkUrl = url.split('#')[0];
  const isBlocked = rules.gates.some(
    (gate) => (isFrame || gate.blocksAllRequests) && new RegExp(gate.pattern, 'i').test(networkUrl),
  );
  const isExcepted = isFrame && rules.exceptions.some((exception) => new RegExp(exception.pattern).test(networkUrl));
  return isBlocked && !isExcepted;
};

test('a protected URL is a prefix match on the path and ignores case', () => {
  const rules = rulesOf('example.com/admin');
  for (const url of ['https://example.com/admin', 'http://example.com/admin/users?x=1', 'https://example.com/ADMIN']) {
    assert.equal(isGatedUrl(url, rules), true, url);
    assert.equal(blockedByNetwork(rules, url, { isFrame: true }), true, url);
  }
  for (const url of ['https://example.com/', 'https://example.com.evil.test/admin', 'https://evil.test/?example.com/admin']) {
    assert.equal(isGatedUrl(url, rules), false, url);
    assert.equal(blockedByNetwork(rules, url, { isFrame: true }), false, url);
  }
});

test('only protected URLs with all: also block requests from inside pages', () => {
  const rules = rulesOf('example.com/admin', 'all:api.example.com/token');
  assert.equal(blockedByNetwork(rules, 'https://api.example.com/token/new', { isFrame: false }), true);
  assert.equal(blockedByNetwork(rules, 'https://example.com/admin', { isFrame: false }), false);
  assert.equal(isGatedUrl('https://api.example.com/token', rules), true);
});

test('a host named all can be written with a scheme', () => {
  assert.deepEqual(
    { kind: parseLine('http://all:8080/x').kind, hostname: parseLine('http://all:8080/x').hostname },
    { kind: 'gate', hostname: 'all' },
  );
  assert.equal(parseLine('all:example.com').blocksAllRequests, true);
  assert.equal(parseLine('http://all:8080/x').blocksAllRequests, false);
});

test('an exception is an exact match and opens without Touch ID; the toolbar button can still unlock it', () => {
  const rules = rulesOf('example.com/admin', '!example.com/admin/help');
  assert.equal(isGatedUrl('https://example.com/admin/help', rules), false);
  assert.equal(isUnlockableUrl('https://example.com/admin/help', rules), true);
  assert.equal(blockedByNetwork(rules, 'https://example.com/admin/help', { isFrame: true }), false);
  for (const url of [
    'https://example.com/admin/help/more',
    'https://example.com/admin/help?x=1',
    'https://example.com/admin/help#section',
    'https://example.com/admin/HELP',
    'https://example.com/admin',
  ]) {
    assert.equal(isGatedUrl(url, rules), true, url);
  }
  assert.equal(blockedByNetwork(rules, 'https://example.com/admin/help/more', { isFrame: true }), true);
  assert.equal(blockedByNetwork(rules, 'https://example.com/admin/HELP', { isFrame: true }), true);
});

test('an exception compares the fragment too; * excludes several pages at once', () => {
  const rules = rulesOf('app.example.com', '!app.example.com/#/list', '!app.example.com/public/*');
  assert.equal(isGatedUrl('https://app.example.com/#/list', rules), false);
  assert.equal(isGatedUrl('https://app.example.com/#/settings', rules), true);
  assert.equal(isGatedUrl('https://app.example.com/', rules), true);
  assert.equal(isGatedUrl('https://app.example.com/public/a/b?c#d', rules), true);
  assert.equal(isGatedUrl('https://app.example.com/public/a/b?c', rules), false);

  const withAnyFragment = rulesOf('example.com/docs', '!example.com/docs/guide#*');
  assert.equal(isGatedUrl('https://example.com/docs/guide', withAnyFragment), false);
  assert.equal(isGatedUrl('https://example.com/docs/guide#install', withAnyFragment), false);
  assert.equal(isGatedUrl('https://example.com/docs/guide/x#install', withAnyFragment), true);
});

test('an exception has no effect outside protected URLs and does not unblock all: requests', () => {
  const rules = rulesOf('all:api.example.com', '!api.example.com/health', '!other.example.com/');
  assert.equal(isUnlockableUrl('https://other.example.com/', rules), false);
  assert.equal(isGatedUrl('https://api.example.com/health', rules), false);
  assert.equal(blockedByNetwork(rules, 'https://api.example.com/health', { isFrame: false }), true);
});

test('a fragment is only allowed in exceptions', () => {
  assert.throws(() => parseLine('example.com/#/x'), /fragment/i);
  assert.equal(parseLine('!example.com/#/x').fragment, '#/x');
  assert.equal(parseLine('!example.com/a#').fragment, '');
});

test('input validation keeps comments and blank lines, drops duplicate lines, and reports errors per line', () => {
  const { lines, errors } = parseLines(['', '# note', 'example.com', '', '', 'example.com', 'bad host/', '!example.com/x', '']);
  assert.deepEqual(lines, ['# note', 'example.com', '', '!example.com/x']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^bad host\//);
  assert.throws(() => parseLines([1]), /format/);
});

test('other lines still work when a stored line cannot be parsed', (context) => {
  context.mock.method(console, 'error', () => {});
  const rules = rulesOf('bad host/', 'example.com');
  assert.equal(isGatedUrl('https://example.com/', rules), true);
});

test('the AWS IAM Identity Center example', () => {
  const rules = buildRules({ lines: AWS_IAM_IDENTITY_CENTER.lines });
  const free = [
    'https://d-1234567890.awsapps.com/start',
    'https://d-1234567890.awsapps.com/start/',
    'https://d-1234567890.awsapps.com/start/#/',
    'https://d-1234567890.awsapps.com/start/#/?tab=accounts',
    'https://d-1234567890.awsapps.com/start/#/?tab=applications',
    'https://ssoins-1.portal.us-east-1.app.aws/',
    'https://ssoins-1.portal.us-east-1.app.aws/#/?tab=accounts',
    'https://a.us-east-1.portal.amazonaws.com/start/#/',
  ];
  const gated = [
    'https://d-1234567890.awsapps.com/start/#/console?account_id=1',
    'https://d-1234567890.awsapps.com/start/?x=1',
    'https://ssoins-1.portal.us-east-1.app.aws/#/console',
    'https://oidc.us-east-1.amazonaws.com/authorize?response_type=code',
    'https://oidc.ap-northeast-1.api.aws/authorize',
    'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD',
  ];
  for (const url of free) {
    assert.equal(isGatedUrl(url, rules), false, url);
    assert.equal(isUnlockableUrl(url, rules), true, url);
    assert.equal(blockedByNetwork(rules, url, { isFrame: true }), false, url);
  }
  for (const url of gated) assert.equal(isGatedUrl(url, rules), true, url);
  for (const url of [
    'https://portal.sso.us-east-1.amazonaws.com/federation/console?account_id=1',
    'https://portal.sso.us-east-1.api.aws/federation/credentials',
    'https://oidc.us-east-1.amazonaws.com/device_authorization/associate_token',
  ]) {
    assert.equal(blockedByNetwork(rules, url, { isFrame: false }), true, url);
  }
  assert.equal(blockedByNetwork(rules, 'https://portal.sso.us-east-1.amazonaws.com/instance/appinstances', { isFrame: false }), false);
  assert.equal(isUnlockableUrl('https://console.aws.amazon.com/', rules), false);
});

test('a fresh install starts with the AWS IAM Identity Center example as its protected URLs', async (context) => {
  const items = mockStorage(context, {});
  assert.deepEqual((await loadSettings()).lines, AWS_IAM_IDENTITY_CENTER.lines);
  await initializeSettings();
  assert.deepEqual(items.settings.lines, AWS_IAM_IDENTITY_CENTER.lines);
  // They can be saved again as is (validation does not change the lines).
  assert.deepEqual(parseLines(DEFAULT_SETTINGS.lines), { lines: [...AWS_IAM_IDENTITY_CENTER.lines], errors: [] });
});

test('stored settings are never rewritten, even when empty', async (context) => {
  for (const lines of [[], ['example.com/admin']]) {
    const items = mockStorage(context, { settings: { lines } });
    await initializeSettings();
    assert.deepEqual(items.settings, { lines });
    assert.deepEqual(await loadSettings(), { lines });
  }
});

test('settings from 0.3 and earlier are stored in the current format on update', async (context) => {
  const items = mockStorage(context, { settings: { awsPreset: false, customPatterns: ['example.com'] } });
  await initializeSettings();
  assert.deepEqual(items.settings, { lines: ['example.com'] });
});

test('the AWS IAM Identity Center example in the docs matches the lines that are actually installed', async () => {
  const page = await readFile(new URL('../docs/aws-iam-identity-center.md', import.meta.url), 'utf8');
  const [, block] = page.match(/```\n([\s\S]*?)\n```/);
  assert.deepEqual(block.split('\n'), AWS_IAM_IDENTITY_CENTER.lines);
});

test('settings from 0.3 and earlier are converted into equivalent lines', () => {
  const withPreset = convertLegacySettings({ awsPreset: true, customPatterns: ['example.com/admin*'] });
  assert.deepEqual(withPreset.lines, [...AWS_IAM_IDENTITY_CENTER.lines, '', 'example.com/admin*']);
  assert.deepEqual(convertLegacySettings({ awsPreset: false, customPatterns: ['example.com'] }).lines, ['example.com']);
  // Up to 0.3 the AWS URLs were protected even when no settings were stored.
  assert.deepEqual(convertLegacySettings(undefined).lines, AWS_IAM_IDENTITY_CENTER.lines);
  assert.deepEqual(parseLines(withPreset.lines).errors, []);
});

test('AWS exceptions that overlap a URL pattern added in 0.3 or earlier are not carried over', () => {
  const urls = {
    ownPortalList: 'https://d-1234567890.awsapps.com/start/#/',
    otherPortalList: 'https://ssoins-1.portal.us-east-1.app.aws/#/?tab=accounts',
  };
  const gatedAfterMigration = (customPatterns) => {
    const rules = buildRules(convertLegacySettings({ awsPreset: true, customPatterns }));
    return Object.fromEntries(Object.entries(urls).map(([name, url]) => [name, isGatedUrl(url, rules)]));
  };
  // In 0.3 an added URL pattern took priority over the exceptions for the list screens.
  for (const pattern of ['*.awsapps.com/start', 'd-1234567890.awsapps.com', '*.com/START/*', 'https://*awsapps.com:443/st*']) {
    assert.deepEqual(gatedAfterMigration([pattern]), { ownPortalList: true, otherPortalList: false }, pattern);
  }
  for (const pattern of ['example.com/admin*', 'awsapps.com.example.com', '*.awsapps.com/start/x', 'd-1.awsapps.com/other']) {
    assert.deepEqual(gatedAfterMigration([pattern]), { ownPortalList: false, otherPortalList: false }, pattern);
  }
});

test('a 0.3 pattern for a host named all with a port still points at the same URL after conversion', () => {
  const settings = convertLegacySettings({ awsPreset: false, customPatterns: ['all:8080/admin', 'example.com'] });
  assert.deepEqual(settings.lines, ['http://all:8080/admin', 'example.com']);
  const rules = buildRules(settings);
  assert.equal(isGatedUrl('https://all:8080/admin/x', rules), true);
  assert.equal(rules.gates.some((gate) => gate.blocksAllRequests), false);
});

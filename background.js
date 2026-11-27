import {
  UNLOCK_MINUTES,
  buildRules,
  initializeSettings,
  isGatedUrl,
  isUnlockableUrl,
  loadRules,
  onSettingsChanged,
  parseLines,
  storeSettings,
} from './config.js';
import { loadCredential, randomChallenge, verifyAssertion } from './webauthn.js';

// The rule with the higher priority wins: block for protected URLs < allow for exceptions < allow for a tab that passed Touch ID.
const BLOCK_PRIORITY = 1;
const EXCEPTION_PRIORITY = 2;
const UNLOCK_PRIORITY = 3;
const FRAME_RESOURCE_TYPES = ['main_frame', 'sub_frame'];
// Protected URLs that also block requests can be called by fetch inside a page, so every resource type is blocked, not just navigations.
const ALL_RESOURCE_TYPES = Object.values(chrome.declarativeNetRequest.ResourceType);
// The protected URLs change with the settings, so every navigation is received first and matched afterwards.
const WATCHED_NAVIGATIONS = { url: [{ schemes: ['http', 'https'] }] };
const RELOCK_ALARM_PREFIX = 'relock:';
const GATE_PAGE_URL = chrome.runtime.getURL('gate.html');
const OPTIONS_PAGE_URL = chrome.runtime.getURL('options.html');

const MILLISECONDS_PER_MINUTE = 60_000;
const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
// For credentials registered by versions that did not specify an RP ID. Chromium uses
// "chrome-extension://<extension ID>" as the default RP ID of an extension page. The bare extension ID is
// accepted too, in case implementations differ.
const LEGACY_RP_IDS = [EXTENSION_ORIGIN, chrome.runtime.id];

const challengeKey = (tabId) => `challenge:${tabId}`;
const unlockExpiryKey = (tabId) => `unlockExpiresAt:${tabId}`;

const PREPARED_VERSION_KEY = 'preparedVersion';
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

const logError = (context) => (error) => console.error(`[url-gate] ${context}`, error);

// installQueue already logs failures, so they are swallowed here.
const ignoreError = () => {};

// The maximum number of regex rules Chrome accepts.
const MAX_REGEX_RULES = chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES ?? 1000;

// Network rules built from the settings. Protected URLs are blocked; exceptions allow only opening the page.
// Exception lines often differ only in the fragment, so identical regular expressions are merged into one.
function networkRuleCandidates(rules) {
  const exceptionsByPattern = new Map(rules.exceptions.map((entry) => [entry.pattern, entry]));
  return [
    ...rules.gates.map((entry) => ({
      entry,
      priority: BLOCK_PRIORITY,
      actionType: 'block',
      resourceTypes: entry.blocksAllRequests ? ALL_RESOURCE_TYPES : FRAME_RESOURCE_TYPES,
      isCaseSensitive: false,
    })),
    ...[...exceptionsByPattern.values()].map((entry) => ({
      entry,
      priority: EXCEPTION_PRIORITY,
      actionType: 'allow',
      resourceTypes: FRAME_RESOURCE_TYPES,
      isCaseSensitive: true,
    })),
  ];
}

const isRegexSupported = ({ entry, isCaseSensitive }) =>
  chrome.declarativeNetRequest.isRegexSupported({ regex: entry.pattern, isCaseSensitive });

// Return the regular expressions that cannot become rules (rejected by RE2, or too large), with the reasons.
async function findUnsupportedRegexes(candidates) {
  const results = await Promise.all(candidates.map(isRegexSupported));
  return candidates
    .map(({ entry }, index) => ({ entry, result: results[index] }))
    .filter(({ result }) => !result.isSupported);
}

// Before saving, make sure the settings can be registered as network rules.
async function assertEnforceable(rules) {
  const candidates = networkRuleCandidates(rules);
  if (candidates.length > MAX_REGEX_RULES) {
    throw new Error(`Too many protected URLs and exceptions (up to ${MAX_REGEX_RULES}, currently ${candidates.length})`);
  }
  const unsupported = await findUnsupportedRegexes(candidates);
  if (unsupported.length > 0) {
    const labels = unsupported.map(({ entry, result }) => `${entry.label} (${result.reason})`);
    throw new Error(`Some URL patterns cannot be turned into block rules: ${labels.join(' / ')}`);
  }
}

async function supportedNetworkRules(rules) {
  const candidates = networkRuleCandidates(rules);
  const unsupported = new Set((await findUnsupportedRegexes(candidates)).map(({ entry }) => entry));
  // One unsupported regular expression would fail the whole registration, so unsupported ones are left out and logged.
  // They are checked on save, so normally nothing is left out here. A protected URL left out is still redirected when its navigation is detected.
  for (const entry of unsupported) console.error(`[url-gate] URL that cannot be turned into a block rule: ${entry.label}`);
  return candidates.filter(({ entry }) => !unsupported.has(entry));
}

// Always-on blocking. Dynamic rules survive a browser restart and work even while this service worker is stopped.
async function installBlockRules() {
  const networkRules = await supportedNetworkRules(await loadRules());
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRules.map((rule) => rule.id),
    addRules: networkRules.map(({ entry, priority, actionType, resourceTypes, isCaseSensitive }, index) => ({
      id: index + 1,
      priority,
      action: { type: actionType },
      condition: {
        regexFilter: entry.pattern,
        isUrlFilterCaseSensitive: isCaseSensitive,
        resourceTypes,
      },
    })),
  });
}

// Overlapping registrations would collide on rule IDs, so they run one at a time.
// The return value is the result of this registration. A failure does not stop later registrations.
let installQueue = Promise.resolve();
function reinstallBlockRules() {
  const installation = installQueue.then(installBlockRules);
  installQueue = installation.catch(logError('Failed to register the block rules'));
  return installation;
}

// After an install or update, bring the settings to the current format and rebuild the block rules.
async function prepare() {
  await initializeSettings();
  await reinstallBlockRules();
  await chrome.storage.local.set({ [PREPARED_VERSION_KEY]: EXTENSION_VERSION });
}

// If the service worker stops before the onInstalled work finishes, the preparation is left incomplete.
// To cover that, every time the service worker starts it checks whether this version has been prepared.
async function prepareIfVersionChanged() {
  const stored = await chrome.storage.local.get(PREPARED_VERSION_KEY);
  if (stored[PREPARED_VERSION_KEY] !== EXTENSION_VERSION) await prepare();
}

let prepared = prepareIfVersionChanged().catch(logError('Failed to prepare on startup'));

// The rules built from the settings. Cached while the service worker is alive and rebuilt when the settings change.
// Read only after the preparation (settings migration) is done.
let rulesPromise = null;
const getRules = () => (rulesPromise ??= prepared.then(loadRules));

// Alarms can fire late, so expiry is decided from the stored time. An expired tab is relocked here.
async function isTabUnlocked(tabId) {
  const key = unlockExpiryKey(tabId);
  const stored = await chrome.storage.session.get(key);
  if (stored[key] === undefined) return false;
  if (Date.now() < stored[key]) return true;
  await relockTab(tabId);
  return false;
}

// Unlocking is a per-tab session rule (rule ID = tab ID). Sign-in flows cross hosts, so it is not narrowed by URL.
// The allow only cancels this extension's own blocks, so URLs that are not protected are unaffected.
async function unlockTab(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [
      {
        id: tabId,
        priority: UNLOCK_PRIORITY,
        action: { type: 'allow' },
        condition: {
          tabIds: [tabId],
          resourceTypes: ALL_RESOURCE_TYPES,
        },
      },
    ],
  });
  await chrome.storage.session.set({
    [unlockExpiryKey(tabId)]: Date.now() + UNLOCK_MINUTES * MILLISECONDS_PER_MINUTE,
  });
  await chrome.alarms.create(`${RELOCK_ALARM_PREFIX}${tabId}`, { delayInMinutes: UNLOCK_MINUTES });
}

async function relockTab(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
  await chrome.storage.session.remove(unlockExpiryKey(tabId));
  await chrome.alarms.clear(`${RELOCK_ALARM_PREFIX}${tabId}`);
}

async function showGate(tabId, targetUrl) {
  if (await isTabUnlocked(tabId)) return;
  await chrome.tabs.update(tabId, {
    url: `${GATE_PAGE_URL}?target=${encodeURIComponent(targetUrl)}`,
  });
}

async function redirectToGate(details) {
  if (details.frameId !== 0 || !isGatedUrl(details.url, await getRules())) return;
  await showGate(details.tabId, details.url);
}

// The toolbar button. Unlocks the current tab, for example to use blocked requests while staying on an exception page.
async function showGateForCurrentPage(tab) {
  if (tab.id === undefined || !isUnlockableUrl(tab.url ?? '', await getRules())) return;
  await showGate(tab.id, tab.url);
}

async function issueChallenge(_message, tabId) {
  const challenge = randomChallenge();
  await chrome.storage.session.set({ [challengeKey(tabId)]: challenge });
  return { challenge };
}

// Verify the signature over the challenge issued to this tab. Throws on failure.
async function verifyTouchId(assertion, tabId) {
  const key = challengeKey(tabId);
  const stored = await chrome.storage.session.get(key);
  await chrome.storage.session.remove(key);
  const expectedChallenge = stored[key];
  if (!expectedChallenge) throw new Error('No challenge has been issued');

  const credential = await loadCredential();
  if (!credential) throw new Error('Touch ID is not registered');

  await verifyAssertion({
    publicKeySpki: credential.publicKeySpki,
    algorithm: credential.algorithm,
    assertion,
    expectedChallenge,
    expectedOrigin: EXTENSION_ORIGIN,
    acceptedRpIds: credential.rpId ? [credential.rpId] : LEGACY_RP_IDS,
  });
}

async function unlockWithAssertion(message, tabId) {
  if (!isUnlockableUrl(message.target, await getRules())) throw new Error('The destination is not a protected URL');
  await verifyTouchId(message.assertion, tabId);
  await unlockTab(tabId);
  await chrome.tabs.update(tabId, { url: message.target });
  return {};
}

// Saving can remove protected URLs, so saving the settings requires Touch ID as well.
async function saveSettingsWithAssertion(message, tabId) {
  if (!Array.isArray(message.settings?.lines)) throw new Error('The settings format is invalid');
  const { lines, errors } = parseLines(message.settings.lines);
  if (errors.length > 0) throw new Error(`Some lines are not written correctly: ${errors.join(' / ')}`);
  const settings = { lines };
  await assertEnforceable(buildRules(settings));
  await verifyTouchId(message.assertion, tabId);
  await storeSettings(settings);

  // The result of saving includes whether the block rules were registered.
  rulesPromise = null;
  try {
    await reinstallBlockRules();
  } catch (error) {
    throw new Error(`The settings were saved, but registering the block rules failed: ${error.message}`);
  }
  return {};
}

// For each message type, the pages it is accepted from.
const MESSAGE_HANDLERS = {
  challenge: { handle: issueChallenge, pages: [GATE_PAGE_URL, OPTIONS_PAGE_URL] },
  unlock: { handle: unlockWithAssertion, pages: [GATE_PAGE_URL] },
  saveSettings: { handle: saveSettingsWithAssertion, pages: [OPTIONS_PAGE_URL] },
};

chrome.runtime.onInstalled.addListener(({ reason }) => {
  prepared = prepared.then(prepare).catch(logError('Failed to prepare after install'));
  rulesPromise = null;
  // Right after install Touch ID is not registered yet, so open the options page (Touch ID registration and protected URLs) first.
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.runtime.openOptionsPage().catch(logError('Could not open the options page'));
  }
});

onSettingsChanged(() => {
  rulesPromise = null;
  reinstallBlockRules().catch(ignoreError);
});

// Some sites switch screens by changing only the fragment, so navigations other than page loads are watched too.
// onCommitted is needed to catch the final URL when a redirect arrives from a URL that is not protected.
const NAVIGATION_EVENTS = [
  chrome.webNavigation.onBeforeNavigate,
  chrome.webNavigation.onCommitted,
  chrome.webNavigation.onReferenceFragmentUpdated,
  chrome.webNavigation.onHistoryStateUpdated,
];
for (const navigationEvent of NAVIGATION_EVENTS) {
  navigationEvent.addListener((details) => {
    redirectToGate(details).catch(logError('Failed to redirect to the gate page'));
  }, WATCHED_NAVIGATIONS);
}

chrome.action.onClicked.addListener((tab) => {
  showGateForCurrentPage(tab).catch(logError('Failed to show the gate page'));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const handler = MESSAGE_HANDLERS[message?.type];
  const isFromAllowedPage =
    sender.id === chrome.runtime.id && handler?.pages.some((page) => sender.url?.startsWith(page));
  if (!handler || !isFromAllowedPage || tabId === undefined) return false;

  handler.handle(message, tabId).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => {
      logError(`Failed to handle ${message.type}`)(error);
      sendResponse({ ok: false, error: error.message });
    },
  );
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(RELOCK_ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(RELOCK_ALARM_PREFIX.length));
  relockTab(tabId).catch(logError('Failed to relock'));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  relockTab(tabId).catch(logError('Failed to relock on tab close'));
});

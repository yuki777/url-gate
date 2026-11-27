import { AWS_IAM_IDENTITY_CENTER } from './presets.js';

// The start of a URL. Userinfo such as https://user@host/ must not let a URL slip past the match.
const SCHEME = '^https?://([^/?#@]*@)?';

// How long a tab stays unblocked after Touch ID succeeds.
export const UNLOCK_MINUTES = 2;

// ---- Settings ----

const SETTINGS_STORAGE_KEY = 'settings';
// lines holds the lines written on the options page (protected URLs, exceptions, comments, blank lines).
// When no settings are stored, the protected URLs are the AWS IAM Identity Center example. A fresh install gets these.
// They are the same kind of lines anyone can write on the options page, so they can be deleted and saved if unused.
export const DEFAULT_SETTINGS = Object.freeze({ lines: Object.freeze([...AWS_IAM_IDENTITY_CENTER.lines]) });

// Convert settings from 0.3 and earlier (the AWS preset toggle and the added URL patterns) into equivalent lines.
// Up to 0.3 the AWS URLs were protected from the start, so the AWS lines are added even when nothing was stored.
// Up to 0.3 an added URL pattern took priority over the exceptions for the AWS list screens. Exceptions win now,
// so exception lines that overlap an added URL pattern are left out; pages that required Touch ID keep requiring it.
// Up to 0.3 "all:8080/admin" meant port 8080 of a host named "all". A leading all: now has another meaning,
// so a scheme is added to keep pointing at the same URL (with a scheme, both http and https still match).
const escapeLegacyPattern = (pattern) => (ALL_REQUESTS_PREFIX.test(pattern.trim()) ? `http://${pattern.trim()}` : pattern);

export function convertLegacySettings(stored) {
  const customPatterns = Array.isArray(stored?.customPatterns) ? stored.customPatterns.map(escapeLegacyPattern) : [];
  const customGates = customPatterns.flatMap((line) => {
    try {
      const parsed = parseLine(line);
      return parsed.kind === 'gate' ? [parsed] : [];
    } catch {
      return [];
    }
  });
  const overlapsCustomGate = (line) => {
    const parsed = parseLine(line);
    return parsed.kind === 'exception' && customGates.some((gate) => gateOverlapsException(gate, parsed));
  };
  const presetLines =
    stored?.awsPreset === false ? [] : AWS_IAM_IDENTITY_CENTER.lines.filter((line) => !overlapsCustomGate(line));
  const separator = presetLines.length > 0 && customPatterns.length > 0 ? [''] : [];
  return { lines: [...presetLines, ...separator, ...customPatterns] };
}

const isCurrentSettings = (stored) => Array.isArray(stored?.lines);

async function loadStoredSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return stored[SETTINGS_STORAGE_KEY];
}

const toSettings = (stored) => {
  if (stored === undefined) return DEFAULT_SETTINGS;
  return isCurrentSettings(stored) ? stored : convertLegacySettings(stored);
};

export async function loadSettings() {
  return toSettings(await loadStoredSettings());
}

// Only the background script saves, after it has verified Touch ID.
export async function storeSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}

// After an install or update, store the settings in the current format. This never removes a protected URL, so it does not ask for Touch ID.
// Nothing is stored after a fresh install, or when settings were never saved in 0.3 or earlier. Both get the AWS example lines.
// Settings already stored in the current format (including an empty list that was saved) are never rewritten.
export async function initializeSettings() {
  const stored = await loadStoredSettings();
  if (isCurrentSettings(stored)) return;
  await storeSettings(toSettings(stored));
}

// Call the callback whenever the settings change (including a save from another tab).
export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(SETTINGS_STORAGE_KEY in changes)) return;
    callback(toSettings(changes[SETTINGS_STORAGE_KEY].newValue));
  });
}

// ---- URL patterns ----

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isDefaultPort = (port) => port === '80' || port === '443';

// Normalize the path and query the way the browser serializes a URL (percent-encoding of non-ASCII characters, resolving . and ..).
// * is kept as is inside a URL, so the wildcard positions do not move.
function normalizePath(path) {
  // new URL(path, base) would read a path starting with // as a host, so concatenate strings instead.
  const url = new URL(`https://placeholder.invalid${path}`);
  return `${url.pathname}${url.search}`;
}

// The string passed to the URL parser in place of * in a hostname. Chrome escapes * in hostnames, so it is replaced before parsing.
const WILDCARD_LABEL = 'wildcard0x2a';
const countOf = (text, part) => text.split(part).length - 1;

// Normalize the hostname the way the browser serializes a URL (lowercasing, punycode for internationalized
// domain names, expanding IPv4 shorthand such as 127.1).
function normalizeHostname(hostname) {
  if (/[@[\]\\%]/.test(hostname)) throw new Error('The hostname contains a character that is not allowed');
  if (hostname.toLowerCase().includes(WILDCARD_LABEL)) throw new Error('The hostname contains a character that is not allowed');
  const replaced = hostname.replaceAll('*', WILDCARD_LABEL);
  let parsed;
  try {
    parsed = new URL(`http://${replaced}`).hostname;
  } catch {
    throw new Error('The hostname cannot be parsed');
  }
  // With non-ASCII characters and * in the same label, punycode encoding loses track of where the * was.
  const mixesWithPunycode = parsed.split('.').some((label) => label.startsWith('xn--') && label.includes(WILDCARD_LABEL));
  if (mixesWithPunycode || countOf(parsed, WILDCARD_LABEL) !== countOf(replaced, WILDCARD_LABEL)) {
    throw new Error('* and non-ASCII characters cannot be in the same part of a domain (between two dots)');
  }
  const normalized = parsed.replaceAll(WILDCARD_LABEL, '*');
  if (!/^[a-z0-9.*_-]+$/.test(normalized)) throw new Error('The hostname contains a character that is not allowed');
  if (!/[a-z0-9]/.test(normalized)) throw new Error('The hostname cannot consist of * only');
  return normalized;
}

// Parse one line from the options page. There are three kinds of lines.
// - Protected URL (example.com/admin): blocks opening the page (navigations and iframe loads).
// - Protected URL that also blocks requests (all:api.example.com/token): also blocks requests from scripts inside pages.
// - Exception (!example.com/admin/help): a page within the protected URLs that opens without Touch ID.
//
// How protected URLs are written:
// - The scheme is optional; both http and https match either way.
// - * in the host matches part of a hostname (e.g. *.example.com, app-*.example.com); * in the path matches any string.
// - The path is a prefix match. Without a path, every page on the host is protected.
// - A fragment (# and what follows) is not allowed.
// Exceptions are written the same way, but the path is an exact match (case-sensitive) and a fragment is allowed.
// To keep the unprotected range from growing too wide, an exception matches only the URL exactly as written.
// Consecutive * are collapsed into one.
const EXCEPTION_PREFIX = '!';
// To write a port on a host named "all", add a scheme, as in http://all:8080.
const ALL_REQUESTS_PREFIX = /^all:/i;
const COMMENT_PREFIX = '#';

const isRuleLine = (text) => text !== '' && !text.startsWith(COMMENT_PREFIX);

function parsePattern(text, { allowsFragment }) {
  if (/\s/.test(text)) throw new Error('Whitespace is not allowed');
  const withoutScheme = text.replace(/^(\*|https?):\/\//i, '');
  const hostEnd = withoutScheme.search(/[/?#]/);
  const host = hostEnd === -1 ? withoutScheme : withoutScheme.slice(0, hostEnd);
  // When hostEnd is at ? or #, the browser inserts a /, so the path starts with / here too.
  const rest = hostEnd === -1 ? '' : withoutScheme.slice(hostEnd);
  const pathAndFragment = rest === '' || rest.startsWith('/') ? rest : `/${rest}`;
  const fragmentStart = pathAndFragment.indexOf('#');
  const rawPath = fragmentStart === -1 ? pathAndFragment : pathAndFragment.slice(0, fragmentStart);
  const rawFragment = fragmentStart === -1 ? '' : pathAndFragment.slice(fragmentStart);
  // A fragment is not part of the request URL, so block rules cannot stop it (and loading in an iframe bypasses the redirect).
  if (rawFragment !== '' && !allowsFragment) throw new Error('A fragment (# and what follows) is only allowed in exceptions (lines starting with !)');

  const [, rawHostname, rawPort = ''] = host.match(/^(.*?)(?::([0-9]+))?$/);
  if (rawHostname.includes(':')) throw new Error('The port is not written correctly');
  // A port written like 08443 becomes 8443, as in the browser.
  const portNumber = Number(rawPort);
  if (rawPort !== '' && (portNumber < 1 || portNumber > 65535)) throw new Error('The port must be between 1 and 65535');
  const port = rawPort === '' ? '' : String(portNumber);
  const hostname = normalizeHostname(rawHostname).replace(/\*+/g, '*');
  const path = rawPath === '' ? '' : normalizePath(rawPath).replace(/\*+/g, '*');
  // The browser treats a bare # as an empty fragment, so do the same.
  const fragment = new URL(`https://placeholder.invalid/${rawFragment}`).hash.replace(/\*+/g, '*');
  return { hostname, port, path, fragment };
}

export function parseLine(line) {
  const text = line.trim();
  if (!isRuleLine(text)) return { kind: 'comment' };
  if (text.startsWith(EXCEPTION_PREFIX)) {
    return { kind: 'exception', ...parsePattern(text.slice(EXCEPTION_PREFIX.length), { allowsFragment: true }) };
  }
  const blocksAllRequests = ALL_REQUESTS_PREFIX.test(text);
  const pattern = parsePattern(text.replace(ALL_REQUESTS_PREFIX, ''), { allowsFragment: false });
  return { kind: 'gate', blocksAllRequests, ...pattern };
}

// ---- Regular expressions for block rules (RE2) ----

// * in the host matches only within the hostname (up to / ? # :). A leading *. also matches the host without a subdomain.
// The browser drops default ports (80 for http, 443 for https) from URLs, so a written default port also matches a URL without it.
function originRegex({ hostname, port }) {
  const hasLeadingWildcard = hostname.startsWith('*.');
  const hostBody = (hasLeadingWildcard ? hostname.slice(2) : hostname).split('*').map(escapeRegex).join('[^/?#:]*');
  const hostRegex = hasLeadingWildcard ? `([^/?#:]*\\.)?${hostBody}` : hostBody;
  const portRegex = port === '' ? '(:[0-9]+)?' : isDefaultPort(port) ? `(:${port})?` : `:${port}`;
  return `${SCHEME}${hostRegex}${portRegex}`;
}

// Protected URL. The path is a prefix match.
function gateToRegex(pattern) {
  const pathRegex = pattern.path === '' ? '([/?#]|$)' : pattern.path.split('*').map(escapeRegex).join('.*');
  return `${originRegex(pattern)}${pathRegex}`;
}

// An exception without a path means the top page (/) only.
const exceptionPath = (pattern) => (pattern.path === '' ? '/' : pattern.path);

// Exception. Request URLs carry no fragment, so this is an exact match up to the #.
function exceptionToRegex(pattern) {
  const pathRegex = exceptionPath(pattern).split('*').map(escapeRegex).join('[^#]*');
  return `${originRegex(pattern)}${pathRegex}(#.*)?$`;
}

// ---- Matching navigations ----

// Exact match against a pattern whose only wildcard is *. Backtracking goes no further than the last *, so the time is bounded by the product of the lengths.
function matchesGlob(text, glob) {
  let textIndex = 0;
  let globIndex = 0;
  let starIndex = -1;
  let starTextIndex = 0;
  while (textIndex < text.length) {
    if (globIndex < glob.length && glob[globIndex] === '*') {
      starIndex = globIndex++;
      starTextIndex = textIndex;
    } else if (globIndex < glob.length && glob[globIndex] === text[textIndex]) {
      globIndex++;
      textIndex++;
    } else if (starIndex !== -1) {
      globIndex = starIndex + 1;
      textIndex = ++starTextIndex;
    } else {
      return false;
    }
  }
  while (glob[globIndex] === '*') globIndex++;
  return globIndex === glob.length;
}

// Prefix match. Looks for the pieces between * from left to right, each at its earliest position (anything may follow, so this is enough).
function matchesGlobPrefix(text, glob) {
  const [head, ...parts] = glob.split('*');
  if (!text.startsWith(head)) return false;
  let position = head.length;
  for (const part of parts) {
    const index = text.indexOf(part, position);
    if (index === -1) return false;
    position = index + part.length;
  }
  return true;
}

function matchesOrigin(url, { hostname, port }) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const hostMatches =
    matchesGlob(url.hostname, hostname) || (hostname.startsWith('*.') && matchesGlob(url.hostname, hostname.slice(2)));
  const portMatches = port === '' || url.port === port || (isDefaultPort(port) && url.port === '');
  return hostMatches && portMatches;
}

// A page can produce very long URLs, so compare with a time-bounded method instead of relying on regex backtracking.
// Matches the same range as the block rule (gateToRegex) and, like the block rule, ignores case.
function gateMatcher(pattern) {
  const lowerPath = pattern.path.toLowerCase();
  return (urlText) => {
    const url = new URL(urlText);
    return matchesOrigin(url, pattern) && matchesGlobPrefix(`${url.pathname}${url.search}`.toLowerCase(), lowerPath);
  };
}

// An exception is an exact match including the fragment. An exception written without a fragment matches only URLs without one.
// A URL without a fragment is compared as "#", so writing "#*" matches with or without a fragment.
function exceptionMatcher(pattern) {
  const path = exceptionPath(pattern);
  const fragment = pattern.fragment || '#';
  return (urlText) => {
    const url = new URL(urlText);
    return (
      matchesOrigin(url, pattern) &&
      matchesGlob(`${url.pathname}${url.search}`, path) &&
      matchesGlob(url.hash || '#', fragment)
    );
  };
}

// Whether some string matches both of two patterns that contain *.
function globsIntersect(first, second) {
  const memo = new Map();
  const visit = (firstIndex, secondIndex) => {
    if (firstIndex === first.length && secondIndex === second.length) return true;
    const key = firstIndex * (second.length + 1) + secondIndex;
    if (!memo.has(key)) {
      const hasFirst = firstIndex < first.length;
      const hasSecond = secondIndex < second.length;
      let result;
      if (hasFirst && first[firstIndex] === '*') {
        result = visit(firstIndex + 1, secondIndex) || (hasSecond && visit(firstIndex, secondIndex + 1));
      } else if (hasSecond && second[secondIndex] === '*') {
        result = visit(firstIndex, secondIndex + 1) || (hasFirst && visit(firstIndex + 1, secondIndex));
      } else {
        result = hasFirst && hasSecond && first[firstIndex] === second[secondIndex] && visit(firstIndex + 1, secondIndex + 1);
      }
      memo.set(key, result);
    }
    return memo.get(key);
  };
  return visit(0, 0);
}

// A leading *. also matches the host without a subdomain, so compare that form too.
const hostnameForms = (hostname) => (hostname.startsWith('*.') ? [hostname, hostname.slice(2)] : [hostname]);

// Whether some URL can match both a protected URL and an exception. Protected URLs ignore the fragment, so it is not compared.
function gateOverlapsException(gate, exception) {
  const hostsOverlap = hostnameForms(gate.hostname).some((gateHost) =>
    hostnameForms(exception.hostname).some((exceptionHost) => globsIntersect(gateHost, exceptionHost)),
  );
  const portsOverlap =
    gate.port === '' || exception.port === '' || gate.port === exception.port || (isDefaultPort(gate.port) && isDefaultPort(exception.port));
  const pathsOverlap = globsIntersect(`${gate.path.toLowerCase()}*`, exceptionPath(exception).toLowerCase());
  return hostsOverlap && portsOverlap && pathsOverlap;
}

// ---- Options page input ----

// Validate the options page input (one entry per line). Duplicate lines are dropped. Comments and blank lines are kept for readability.
export function parseLines(lines) {
  const kept = [];
  const errors = [];
  for (const line of lines) {
    if (typeof line !== 'string') throw new Error('The settings format is invalid');
    const text = line.trim();
    if (isRuleLine(text)) {
      if (kept.includes(text)) continue;
      try {
        parseLine(text);
      } catch (error) {
        errors.push(`${text}: ${error.message}`);
        continue;
      }
    }
    // Do not keep consecutive blank lines.
    if (text === '' && (kept.length === 0 || kept.at(-1) === '')) continue;
    kept.push(text);
  }
  while (kept.at(-1) === '') kept.pop();
  return { lines: kept, errors };
}

// ---- Rules ----

// Build the lists of protected URLs and exceptions from the settings.
// - gates: URLs that cannot be opened until Touch ID succeeds. With blocksAllRequests, requests from inside pages are blocked too.
// - exceptions: pages within gates that open without Touch ID.
// pattern is the regular expression for the block rule; test is for matching navigations.
export function buildRules(settings) {
  const gates = [];
  const exceptions = [];
  for (const line of settings.lines) {
    let parsed;
    try {
      parsed = parseLine(line);
    } catch (error) {
      // Lines are validated on save, so this is not normally reached. Skip just this line rather than stopping everything.
      console.error(`[url-gate] Ignoring a line that cannot be parsed: ${line}`, error);
      continue;
    }
    const label = line.trim();
    if (parsed.kind === 'gate') {
      gates.push({ label, pattern: gateToRegex(parsed), test: gateMatcher(parsed), blocksAllRequests: parsed.blocksAllRequests });
    } else if (parsed.kind === 'exception') {
      exceptions.push({ label, pattern: exceptionToRegex(parsed), test: exceptionMatcher(parsed) });
    }
  }
  return { gates, exceptions };
}

export async function loadRules() {
  return buildRules(await loadSettings());
}

const matchesAny = (entries, urlText) => entries.some((entry) => entry.test(urlText));

// URLs a tab may open after Touch ID (including exception pages). This is also the range the gate page accepts as a destination.
export function isUnlockableUrl(urlText, rules) {
  return URL.canParse(urlText) && matchesAny(rules.gates, urlText);
}

// URLs that cannot be opened until Touch ID succeeds.
export function isGatedUrl(urlText, rules) {
  return isUnlockableUrl(urlText, rules) && !matchesAny(rules.exceptions, urlText);
}

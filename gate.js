import { UNLOCK_MINUTES, isUnlockableUrl, loadRules } from './config.js';
import { loadCredential, onCredentialChanged, registerCredential, requestAssertion } from './webauthn.js';

const parameters = new URLSearchParams(location.search);
const target = parameters.get('target') ?? '';
// Set when the toolbar button opened this page: the tab to unlock. The page in that tab stays open, and this tab closes afterwards.
const tabToUnlock = parameters.has('tab') ? Number(parameters.get('tab')) : undefined;
const unlocksOtherTab = tabToUnlock !== undefined;
const unlockButton = document.getElementById('unlock');
const registerButton = document.getElementById('register');
const status = document.getElementById('status');

const TEXT = unlocksOtherTab
  ? {
      description: `URL Gate is blocking requests from the following page. After you verify with Touch ID, they are allowed in its tab for ${UNLOCK_MINUTES} minutes and you return to the page.`,
      unlock: 'Unlock with Touch ID',
      register: 'Register Touch ID and unlock',
      notRegistered: 'Touch ID is not registered yet. After you register, URL Gate verifies you and unlocks the page.',
      verified: 'Verified. Returning to the page…',
      failed: 'Could not unlock',
      failedAfterRegistering: 'Registered, but could not unlock',
    }
  : {
      unlock: 'Open with Touch ID',
      notRegistered: 'Touch ID is not registered yet. After you register, URL Gate verifies you and opens this URL.',
      verified: 'Verified. Opening the page…',
      failed: 'Could not open',
      failedAfterRegistering: 'Registered, but could not open',
    };

document.getElementById('target').textContent = target;
if (unlocksOtherTab) {
  document.getElementById('description').textContent = TEXT.description;
  unlockButton.textContent = TEXT.unlock;
  registerButton.textContent = TEXT.register;
}

async function sendToBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'No response from the background script');
  return response;
}

// Show only "Open" when registered, and only "Register and open" when not.
function showButtonsFor(credential) {
  unlockButton.hidden = !credential;
  registerButton.hidden = Boolean(credential);
  (credential ? unlockButton : registerButton).focus();
}

function setBusy(isBusy) {
  unlockButton.disabled = isBusy;
  registerButton.disabled = isBusy;
}

async function unlockWith(credential) {
  const { challenge } = await sendToBackground({ type: 'challenge' });
  const assertion = await requestAssertion(credential, challenge);
  await sendToBackground({ type: 'unlock', assertion, target, tab: tabToUnlock });
  if (unlocksOtherTab) await closeThisTab();
}

// The background script has already switched back to the unlocked tab.
async function closeThisTab() {
  const thisTab = await chrome.tabs.getCurrent();
  await chrome.tabs.remove(thisTab.id);
}

// Closing the Touch ID dialog and timing out both give NotAllowedError. That is not a fault, so it is not logged as an error.
const isDismissed = (error) => error?.name === 'NotAllowedError';

// Even when the automatic call and the button overlap, Touch ID is shown only once.
let isUnlocking = false;

async function unlock() {
  if (isUnlocking) return;
  isUnlocking = true;
  setBusy(true);
  status.textContent = 'Waiting for Touch ID…';
  try {
    const credential = await loadCredential();
    // For example the registration was removed in another tab. Not being registered is not a fault, so it is not logged as an error.
    if (!credential) {
      showButtonsFor(null);
      status.textContent = TEXT.notRegistered;
      return;
    }
    await unlockWith(credential);
    status.textContent = TEXT.verified;
  } catch (error) {
    if (isDismissed(error)) {
      status.textContent = `Touch ID was not confirmed. Press "${TEXT.unlock}" to try again.`;
    } else {
      console.error('[url-gate] Unlock failed', error);
      status.textContent = `${TEXT.failed}: ${error.message}`;
    }
  } finally {
    isUnlocking = false;
    setBusy(false);
  }
}

unlockButton.addEventListener('click', unlock);

// Touch ID is shown without a button press only when this page was reached by trying to open a protected URL.
// Back/forward, reload and tab restore are not attempts to open it, so nothing is shown then.
const wasOpenedByNavigation = () => performance.getEntriesByType('navigation')[0]?.type === 'navigate';

// Chrome rejects WebAuthn requests from a page without focus.
// When opened in a background tab, for example, wait until this page gets focus.
function whenFocused() {
  if (document.hasFocus()) return Promise.resolve();
  return new Promise((resolve) => {
    window.addEventListener('focus', () => resolve(), { once: true });
  });
}

// Shown automatically only once. After a dismissal or failure, the button is the way to retry.
async function unlockAutomatically() {
  if (!wasOpenedByNavigation()) return;
  await whenFocused();
  // If the registration was removed while waiting, the button is hidden.
  if (unlockButton.hidden) return;
  await unlock();
}

// After registering, go straight on to verification and then to the original URL.
// Registering alone does not unlock. As always, unlocking happens only after the signature over a challenge issued by the background script is verified.
registerButton.addEventListener('click', async () => {
  setBusy(true);
  status.textContent = 'Registering Touch ID…';
  let credential;
  try {
    credential = await registerCredential();
  } catch (error) {
    console.error('[url-gate] Registration failed', error);
    status.textContent = `Could not register: ${error.message}`;
    setBusy(false);
    return;
  }

  showButtonsFor(credential);
  status.textContent = 'Registered. Now verifying with Touch ID…';
  try {
    await unlockWith(credential);
    status.textContent = TEXT.verified;
  } catch (error) {
    console.error('[url-gate] Unlock after registration failed', error);
    status.textContent = `${TEXT.failedAfterRegistering}: ${error.message}. Press "${TEXT.unlock}".`;
  } finally {
    setBusy(false);
  }
});

async function initialize() {
  if (!isUnlockableUrl(target, await loadRules())) {
    status.textContent = 'The destination is not a protected URL, so it cannot be opened.';
    return;
  }

  const credential = await loadCredential();
  showButtonsFor(credential);
  if (!credential) status.textContent = TEXT.notRegistered;

  // Switch the buttons when registration happens in another tab too, such as the options page.
  onCredentialChanged((changed) => {
    if (unlockButton.disabled) return;
    showButtonsFor(changed);
    status.textContent = changed ? '' : TEXT.notRegistered;
  });

  // Registration is something a person starts, so only verification for an existing registration is shown automatically.
  if (credential) await unlockAutomatically();
}

initialize().catch((error) => {
  console.error('[url-gate] Failed to set up the gate page', error);
  status.textContent = `Could not read the registration state: ${error.message}`;
});

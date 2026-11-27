import { isUnlockableUrl, loadRules } from './config.js';
import { loadCredential, onCredentialChanged, registerCredential, requestAssertion } from './webauthn.js';

const target = new URLSearchParams(location.search).get('target') ?? '';
const unlockButton = document.getElementById('unlock');
const registerButton = document.getElementById('register');
const status = document.getElementById('status');

const NOT_REGISTERED_MESSAGE = 'Touch ID is not registered yet. After you register, URL Gate verifies you and opens this URL.';

document.getElementById('target').textContent = target;

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
  await sendToBackground({ type: 'unlock', assertion, target });
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
      status.textContent = NOT_REGISTERED_MESSAGE;
      return;
    }
    await unlockWith(credential);
    status.textContent = 'Verified. Opening the page…';
  } catch (error) {
    if (isDismissed(error)) {
      status.textContent = 'Touch ID was not confirmed. Press "Open with Touch ID" to try again.';
    } else {
      console.error('[url-gate] Unlock failed', error);
      status.textContent = `Could not open: ${error.message}`;
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
    status.textContent = 'Verified. Opening the page…';
  } catch (error) {
    console.error('[url-gate] Unlock after registration failed', error);
    status.textContent = `Registered, but could not open: ${error.message}. Press "Open with Touch ID".`;
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
  if (!credential) status.textContent = NOT_REGISTERED_MESSAGE;

  // Switch the buttons when registration happens in another tab too, such as the options page.
  onCredentialChanged((changed) => {
    if (unlockButton.disabled) return;
    showButtonsFor(changed);
    status.textContent = changed ? '' : NOT_REGISTERED_MESSAGE;
  });

  // Registration is something a person starts, so only verification for an existing registration is shown automatically.
  if (credential) await unlockAutomatically();
}

initialize().catch((error) => {
  console.error('[url-gate] Failed to set up the gate page', error);
  status.textContent = `Could not read the registration state: ${error.message}`;
});

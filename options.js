import { loadSettings, onSettingsChanged, parseLines } from './config.js';
import { loadCredential, registerCredential, requestAssertion } from './webauthn.js';

const state = document.getElementById('state');
const status = document.getElementById('status');
const registerButton = document.getElementById('register');
const linesInput = document.getElementById('lines');
const saveButton = document.getElementById('save');
const settingsStatus = document.getElementById('settings-status');

async function showState() {
  const credential = await loadCredential();
  state.textContent = credential
    ? 'Registered. Registering again replaces the current registration, which stops working.'
    : 'Not registered yet. Until you register, protected URLs cannot be opened and settings cannot be saved.';
  registerButton.textContent = credential ? 'Register Touch ID again' : 'Register Touch ID';
}

function showSettings(settings) {
  linesInput.value = settings.lines.join('\n');
}

async function sendToBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'No response from the background script');
  return response;
}

registerButton.addEventListener('click', async () => {
  registerButton.disabled = true;
  status.textContent = 'Waiting for Touch ID…';
  try {
    await registerCredential();
    status.textContent = 'Registered.';
  } catch (error) {
    console.error('[url-gate] Registration failed', error);
    status.textContent = `Could not register: ${error.message}`;
  } finally {
    registerButton.disabled = false;
    await showState();
  }
});

// The background script saves only after it has verified the Touch ID signature.
saveButton.addEventListener('click', async () => {
  const { lines, errors } = parseLines(linesInput.value.split('\n'));
  if (errors.length > 0) {
    settingsStatus.textContent = `Some lines are not written correctly: ${errors.join(' / ')}`;
    return;
  }

  saveButton.disabled = true;
  try {
    const credential = await loadCredential();
    if (!credential) {
      settingsStatus.textContent = 'Register Touch ID first.';
      return;
    }
    settingsStatus.textContent = 'Waiting for Touch ID…';
    const { challenge } = await sendToBackground({ type: 'challenge' });
    const assertion = await requestAssertion(credential, challenge);
    await sendToBackground({
      type: 'saveSettings',
      assertion,
      settings: { lines },
    });
    settingsStatus.textContent = 'Saved.';
  } catch (error) {
    console.error('[url-gate] Failed to save the settings', error);
    settingsStatus.textContent = `Could not save: ${error.message}`;
  } finally {
    saveButton.disabled = false;
  }
});

// Show the saved lines again (duplicates removed), including a save from another tab.
onSettingsChanged(showSettings);

showState().catch((error) => {
  console.error('[url-gate] Failed to read the registration state', error);
  state.textContent = `Could not read the registration state: ${error.message}`;
});

loadSettings()
  .then(showSettings)
  .catch((error) => {
    console.error('[url-gate] Failed to read the settings', error);
    settingsStatus.textContent = `Could not read the settings: ${error.message}`;
  });

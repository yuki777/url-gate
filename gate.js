import { isUnlockableUrl, loadRules } from './config.js';
import { loadCredential, onCredentialChanged, registerCredential, requestAssertion } from './webauthn.js';

const target = new URLSearchParams(location.search).get('target') ?? '';
const unlockButton = document.getElementById('unlock');
const registerButton = document.getElementById('register');
const status = document.getElementById('status');

const NOT_REGISTERED_MESSAGE = 'Touch ID が未登録です。登録すると、続けて本人確認をして、この URL を開きます。';

document.getElementById('target').textContent = target;

async function sendToBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'バックグラウンドから応答がありません');
  return response;
}

// 登録済みなら「開く」だけ、未登録なら「登録して開く」だけを出す。
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
  const assertion = await requestAssertion(credential.credentialId, challenge);
  await sendToBackground({ type: 'unlock', assertion, target });
}

// Touch ID のダイアログを閉じたときと時間切れは NotAllowedError になる。異常ではないので、エラーとして記録しない。
const isDismissed = (error) => error?.name === 'NotAllowedError';

// 自動の呼び出しとボタンが重なっても、Touch ID を出すのは 1 回だけにする。
let isUnlocking = false;

async function unlock() {
  if (isUnlocking) return;
  isUnlocking = true;
  setBusy(true);
  status.textContent = 'Touch ID を待っています…';
  try {
    const credential = await loadCredential();
    // 別のタブで登録を消した場合など。未登録は異常ではないので、エラーとして記録しない。
    if (!credential) {
      showButtonsFor(null);
      status.textContent = NOT_REGISTERED_MESSAGE;
      return;
    }
    await unlockWith(credential);
    status.textContent = '確認できました。移動します。';
  } catch (error) {
    if (isDismissed(error)) {
      status.textContent = 'Touch ID を確認できませんでした。「Touch ID で開く」を押すと、もう一度試せます。';
    } else {
      console.error('[url-gate] 解除に失敗', error);
      status.textContent = `開けませんでした: ${error.message}`;
    }
  } finally {
    isUnlocking = false;
    setBusy(false);
  }
}

unlockButton.addEventListener('click', unlock);

// 対象 URL を開こうとして着いたときだけ、ボタンを押さなくても Touch ID を出す。
// 戻る・進む、再読み込み、タブの復元で出てきたときは、開こうとした操作ではないので出さない。
const wasOpenedByNavigation = () => performance.getEntriesByType('navigation')[0]?.type === 'navigate';

// Chrome は、フォーカスの無いページからの WebAuthn の要求を断る。
// 裏のタブで開いた場合などは、このページにフォーカスが来るまで待つ。
function whenFocused() {
  if (document.hasFocus()) return Promise.resolve();
  return new Promise((resolve) => {
    window.addEventListener('focus', () => resolve(), { once: true });
  });
}

// 自動で出すのは 1 回だけ。閉じたあとや失敗したあとは、ボタンで試してもらう。
async function unlockAutomatically() {
  if (!wasOpenedByNavigation()) return;
  await whenFocused();
  // 待っている間に登録が消えていたら、ボタンは隠れている。
  if (unlockButton.hidden) return;
  await unlock();
}

// 登録したら、そのまま本人確認をして元の URL へ進む。
// 登録だけでは解除しない。解除はこれまでどおり、バックグラウンドが発行したチャレンジへの署名を検証してから行う。
registerButton.addEventListener('click', async () => {
  setBusy(true);
  status.textContent = 'Touch ID を登録しています…';
  let credential;
  try {
    credential = await registerCredential();
  } catch (error) {
    console.error('[url-gate] 登録に失敗', error);
    status.textContent = `登録できませんでした: ${error.message}`;
    setBusy(false);
    return;
  }

  showButtonsFor(credential);
  status.textContent = '登録しました。続けて Touch ID で本人確認をします…';
  try {
    await unlockWith(credential);
    status.textContent = '確認できました。移動します。';
  } catch (error) {
    console.error('[url-gate] 登録後の解除に失敗', error);
    status.textContent = `登録はできましたが、開けませんでした: ${error.message}。「Touch ID で開く」を押してください。`;
  } finally {
    setBusy(false);
  }
});

async function initialize() {
  if (!isUnlockableUrl(target, await loadRules())) {
    status.textContent = '遷移先が対象 URL ではないため、開けません。';
    return;
  }

  const credential = await loadCredential();
  showButtonsFor(credential);
  if (!credential) status.textContent = NOT_REGISTERED_MESSAGE;

  // 設定ページなど別のタブで登録した場合も、ボタンを切り替える。
  onCredentialChanged((changed) => {
    if (unlockButton.disabled) return;
    showButtonsFor(changed);
    status.textContent = changed ? '' : NOT_REGISTERED_MESSAGE;
  });

  // 登録は人が始める操作なので、自動で出すのは登録済みのときの本人確認だけにする。
  if (credential) await unlockAutomatically();
}

initialize().catch((error) => {
  console.error('[url-gate] ゲートページの準備に失敗', error);
  status.textContent = `登録状態を取得できませんでした: ${error.message}`;
});

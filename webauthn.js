const CREDENTIAL_STORAGE_KEY = 'credential';
// The relying party ID. Left as the extension ID it takes the URL form "chrome-extension://...", which 1Password cannot save.
// To make it a domain, a host in our own namespace that does not exist is used. Keep it in sync with host_permissions in manifest.json.
export const RELYING_PARTY_ID = 'url-gate.yuki777.github.io';
const ES256_ALGORITHM = -7;
const RS256_ALGORITHM = -257;
// The order offered to the authenticator at registration. Earlier entries are preferred.
const SUPPORTED_ALGORITHMS = [ES256_ALGORITHM, RS256_ALGORITHM];
const RP_ID_HASH_LENGTH = 32;
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const P256_COORDINATE_LENGTH = 32;
const CHALLENGE_LENGTH = 32;
const REQUEST_TIMEOUT_MS = 60_000;

export function toBase64Url(buffer) {
  const binary = String.fromCharCode(...new Uint8Array(buffer));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomChallenge() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(CHALLENGE_LENGTH)));
}

export async function loadCredential() {
  const stored = await chrome.storage.local.get(CREDENTIAL_STORAGE_KEY);
  return stored[CREDENTIAL_STORAGE_KEY] ?? null;
}

// Call the callback with the new value whenever the registration changes (including a registration from another tab).
export function onCredentialChanged(callback) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(CREDENTIAL_STORAGE_KEY in changes)) return;
    callback(changes[CREDENTIAL_STORAGE_KEY].newValue ?? null);
  });
}

// Called from extension pages.
export async function registerCredential() {
  const created = await navigator.credentials.create({
    publicKey: {
      rp: { id: RELYING_PARTY_ID, name: 'URL Gate' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'url-gate',
        displayName: 'URL Gate',
      },
      challenge: fromBase64Url(randomChallenge()),
      // Touch ID returns ES256. Chrome shows a compatibility warning unless RS256 is listed as well.
      pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'discouraged',
      },
      attestation: 'none',
      timeout: REQUEST_TIMEOUT_MS,
    },
  });
  const algorithm = created.response.getPublicKeyAlgorithm();
  if (!SUPPORTED_ALGORITHMS.includes(algorithm)) {
    throw new Error(`The authenticator returned an unsupported key (algorithm ${algorithm})`);
  }
  const credential = {
    credentialId: toBase64Url(created.rawId),
    publicKeySpki: toBase64Url(created.response.getPublicKey()),
    algorithm,
    rpId: RELYING_PARTY_ID,
  };
  await chrome.storage.local.set({ [CREDENTIAL_STORAGE_KEY]: credential });
  return credential;
}

// A credential without rpId was registered by a version that did not specify an RP ID (it used the extension ID). The default is used for those.
export async function requestAssertion(credential, challenge) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64Url(challenge),
      ...(credential.rpId ? { rpId: credential.rpId } : {}),
      allowCredentials: [{ type: 'public-key', id: fromBase64Url(credential.credentialId) }],
      userVerification: 'required',
      timeout: REQUEST_TIMEOUT_MS,
    },
  });
  return {
    authenticatorData: toBase64Url(assertion.response.authenticatorData),
    clientDataJSON: toBase64Url(assertion.response.clientDataJSON),
    signature: toBase64Url(assertion.response.signature),
  };
}

// WebAuthn signatures are ASN.1 DER, while WebCrypto wants fixed-length r||s, so convert.
function derSignatureToRaw(der) {
  let offset = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const readInteger = () => {
    if (der[offset] !== 0x02) throw new Error('The signature format is invalid');
    const length = der[offset + 1];
    const start = offset + 2;
    const end = start + length;
    if (end > der.length) throw new Error('The signature format is invalid');
    offset = end;
    let value = der.subarray(start, end);
    while (value.length > P256_COORDINATE_LENGTH && value[0] === 0) value = value.subarray(1);
    if (value.length > P256_COORDINATE_LENGTH) throw new Error('The signature format is invalid');
    const padded = new Uint8Array(P256_COORDINATE_LENGTH);
    padded.set(value, P256_COORDINATE_LENGTH - value.length);
    return padded;
  };
  if (der[0] !== 0x30) throw new Error('The signature format is invalid');
  const r = readInteger();
  const s = readInteger();
  return Uint8Array.from([...r, ...s]);
}

// WebCrypto parameters for each COSE algorithm ID.
const VERIFIERS = {
  [ES256_ALGORITHM]: {
    importParams: { name: 'ECDSA', namedCurve: 'P-256' },
    verifyParams: { name: 'ECDSA', hash: 'SHA-256' },
    toWebCryptoSignature: derSignatureToRaw,
  },
  [RS256_ALGORITHM]: {
    importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verifyParams: { name: 'RSASSA-PKCS1-v1_5' },
    toWebCryptoSignature: (signature) => signature,
  },
};
async function matchesRpId(actualRpIdHash, rpId) {
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  return actualRpIdHash.length === RP_ID_HASH_LENGTH && expected.every((byte, index) => byte === actualRpIdHash[index]);
}

// Throws when verification fails. Returns nothing on success.
// A credential without algorithm was registered by a version that supported ES256 only.
export async function verifyAssertion({
  publicKeySpki,
  algorithm = ES256_ALGORITHM,
  assertion,
  expectedChallenge,
  expectedOrigin,
  acceptedRpIds,
}) {
  const verifier = VERIFIERS[algorithm];
  if (!verifier) throw new Error(`Unsupported key algorithm: ${algorithm}`);

  const authenticatorData = fromBase64Url(assertion.authenticatorData);
  const clientDataBytes = fromBase64Url(assertion.clientDataJSON);
  const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));

  if (clientData.type !== 'webauthn.get') throw new Error('The assertion type is invalid');
  if (clientData.challenge !== expectedChallenge) throw new Error('The challenge does not match');
  if (clientData.origin !== expectedOrigin) throw new Error('The origin does not match');

  const actualRpIdHash = authenticatorData.subarray(0, RP_ID_HASH_LENGTH);
  const rpIdMatches = await Promise.all(acceptedRpIds.map((rpId) => matchesRpId(actualRpIdHash, rpId)));
  if (!rpIdMatches.includes(true)) throw new Error('The RP ID does not match');

  const flags = authenticatorData[RP_ID_HASH_LENGTH];
  if (!(flags & FLAG_USER_PRESENT) || !(flags & FLAG_USER_VERIFIED)) {
    throw new Error('User verification (Touch ID) was not performed');
  }

  const publicKey = await crypto.subtle.importKey(
    'spki',
    fromBase64Url(publicKeySpki),
    verifier.importParams,
    false,
    ['verify'],
  );
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes));
  const signedData = Uint8Array.from([...authenticatorData, ...clientDataHash]);
  const isValid = await crypto.subtle.verify(
    verifier.verifyParams,
    publicKey,
    verifier.toWebCryptoSignature(fromBase64Url(assertion.signature)),
    signedData,
  );
  if (!isValid) throw new Error('The signature is invalid');
}

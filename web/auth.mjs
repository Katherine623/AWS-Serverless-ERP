import { $, el } from './ui.mjs';

// Bumped on sign-out so background pollers can abandon stale responses.
export const session = { generation: 0 };

const store = window.sessionStorage;
const config = { value: null, refreshPromise: null };
const storeKey = name => `erp.${name}`;

export const tokenValue = () => store.getItem(storeKey('id_token')) || store.getItem('erp.jwt') || '';

export function decodeClaims(token) {
  try {
    const part = token.replace(/^Bearer\s+/i, '').split('.')[1];
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map(character => `%${`00${character.charCodeAt(0).toString(16)}`.slice(-2)}`)
        .join(''),
    );
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function tokenExpired(token) {
  const expiry = Number(decodeClaims(token).exp || 0);
  return expiry > 0 && expiry * 1000 <= Date.now() + 60000;
}

export function claimRoles(claims) {
  return [
    ...new Set(
      []
        .concat(claims.roles || [], claims.role || [], claims.groups || [], claims['cognito:groups'] || [])
        .flatMap(value => String(value).replace(/^\[/, '').replace(/\]$/, '').split(/[ ,]+/))
        .filter(Boolean)
        .map(value => value.replace(/^erp:/, '').toLowerCase()),
    ),
  ];
}

export function renderActor() {
  const token = tokenValue();
  // An expired token must still offer login, otherwise the user cannot re-authenticate.
  $('loginButton').hidden = Boolean(token) && !tokenExpired(token);
  $('logoutButton').hidden = !token;
  if (!token) {
    $('actorBadge').textContent = '尚未登入';
    $('roleBadges').replaceChildren(el('span', { className: 'badge warn', textContent: '請先登入' }));
    $('logoutButton').disabled = true;
    return;
  }
  const claims = decodeClaims(token);
  const roles = claimRoles(claims);
  $('actorBadge').textContent = claims.sub || claims.username || '登入使用者';
  $('roleBadges').replaceChildren(
    ...(roles.length
      ? roles.map(role => el('span', { className: 'badge', textContent: role }))
      : [el('span', { className: 'badge warn', textContent: '未取得角色' })]),
  );
  $('logoutButton').disabled = false;
}

export function clearTokens() {
  store.removeItem(storeKey('id_token'));
  store.removeItem(storeKey('refresh_token'));
  store.removeItem('erp.jwt');
  session.generation += 1;
  document.dispatchEvent(new CustomEvent('erp:signout'));
}

export async function loadAuthConfig() {
  if (config.value) return config.value;
  const response = await fetch('/auth/config', { headers: { Accept: 'application/json' } });
  config.value = await response.json();
  return config.value;
}

function saveTokens(data) {
  if (data.id_token) store.setItem(storeKey('id_token'), data.id_token);
  if (data.refresh_token) store.setItem(storeKey('refresh_token'), data.refresh_token);
}

export async function refreshSession() {
  if (config.refreshPromise) return config.refreshPromise;
  config.refreshPromise = (async () => {
    const refreshToken = store.getItem(storeKey('refresh_token'));
    if (!refreshToken) return false;
    const authConfig = await loadAuthConfig();
    if (!authConfig.enabled) return false;
    const response = await fetch(authConfig.token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: authConfig.client_id,
        refresh_token: refreshToken,
      }),
    });
    if (!response.ok) return false;
    saveTokens(await response.json());
    return Boolean(store.getItem(storeKey('id_token')));
  })()
    .catch(() => false)
    .finally(() => {
      config.refreshPromise = null;
    });
  return config.refreshPromise;
}

export async function validToken() {
  const token = tokenValue();
  if (token && !tokenExpired(token)) return token;
  if (await refreshSession()) return tokenValue();
  return '';
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomValue(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function codeChallenge(verifier) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export async function beginLogin() {
  const authConfig = await loadAuthConfig();
  if (!authConfig.enabled) throw new Error('Cognito Hosted UI 尚未部署，請先套用 Terraform。');
  const verifier = randomValue();
  const stateValue = randomValue(16);
  store.setItem('erp.pkce', JSON.stringify({ verifier, state: stateValue }));
  const query = new URLSearchParams({
    client_id: authConfig.client_id,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: authConfig.redirect_uri,
    state: stateValue,
    code_challenge_method: 'S256',
    code_challenge: await codeChallenge(verifier),
  });
  window.location.assign(`${authConfig.authorize_url}?${query}`);
}

export async function completeLogin() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;
  const saved = JSON.parse(store.getItem('erp.pkce') || '{}');
  const authConfig = await loadAuthConfig();
  if (!saved.verifier || !saved.state || saved.state !== params.get('state')) {
    throw new Error('登入回呼驗證失敗，請重新登入。');
  }
  const response = await fetch(authConfig.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: authConfig.client_id,
      code,
      redirect_uri: authConfig.redirect_uri,
      code_verifier: saved.verifier,
    }),
  });
  if (!response.ok) throw new Error('Cognito 登入交換 Token 失敗，請重新登入。');
  saveTokens(await response.json());
  store.removeItem('erp.pkce');
  window.history.replaceState({}, document.title, window.location.pathname);
  return true;
}

/** Returns true when the browser is being redirected to the Cognito logout page. */
export async function logout() {
  const authConfig = await loadAuthConfig().catch(() => ({ enabled: false }));
  clearTokens();
  renderActor();
  if (!authConfig.enabled) return false;
  const query = new URLSearchParams({ client_id: authConfig.client_id, logout_uri: authConfig.redirect_uri });
  window.location.assign(`${authConfig.logout_url}?${query}`);
  return true;
}

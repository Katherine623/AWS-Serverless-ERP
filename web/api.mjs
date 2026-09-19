import { refreshSession, validToken } from './auth.mjs';
import { newKey } from './ui.mjs';

const AI_TIMEOUT_MS = 29000;
const DEFAULT_TIMEOUT_MS = 15000;

function apiHeaders(extra, token) {
  const headers = new Headers(extra || {});
  headers.set('Accept', 'application/json');
  headers.set('X-Request-Id', newKey('ui'));
  if (token) headers.set('Authorization', token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`);
  return headers;
}

export function authErrorMessage(error) {
  if (error.status === 401) return '登入已失效，請重新使用 Cognito 登入。';
  if (error.status === 403) return '目前角色沒有執行此操作的權限。';
  return error.message || 'API 請求失敗，請稍後再試。';
}

function failure(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function api(path, options = {}) {
  const token = await validToken();
  if (!token) throw failure('請先使用 Cognito 登入', 401);

  const requestOptions = { ...options, headers: apiHeaders(options.headers || {}, token) };
  if (requestOptions.body && typeof requestOptions.body !== 'string') {
    requestOptions.headers.set('Content-Type', 'application/json');
    requestOptions.body = JSON.stringify(requestOptions.body);
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    path === '/api/ai/chat' ? AI_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
  );
  requestOptions.signal = controller.signal;

  try {
    const response = await fetch(path, requestOptions);
    const raw = await response.text();
    let data = {};
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = { detail: 'API 回應格式無效' };
      }
    }
    if (response.ok) return data;
    if (response.status === 401 && !options.retryAuth && (await refreshSession())) {
      return api(path, { ...options, retryAuth: true });
    }
    throw failure(data.detail || data.message || `API 請求失敗（${response.status}）`, response.status);
  } catch (error) {
    if (error.name === 'AbortError') throw failure('API 請求逾時，請稍後再試', 408);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const state = {
  dashboard: null,
  orders: [],
  allOrders: [],
  inventory: [],
  transactions: [],
  orderCursor: null,
  inventoryCursor: null,
  orderFilters: { status: '', supplier: '' },
  inventoryFilters: { material: '', low: false },
};

const auth = { config: null, refreshPromise: null };
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>\'\"]/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;',
}[character]));
const newKey = prefix => `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
const formatDateTime = value => value ? new Date(value).toLocaleString('zh-TW') : '—';
const setResult = (id, message, type = '') => {
  const element = $(id);
  element.hidden = !message;
  element.className = `result ${type}`;
  element.innerHTML = message;
};
const oauthToken = key => localStorage.getItem(`erp.${key}`) || '';
const tokenValue = () => oauthToken('id_token') || sessionStorage.getItem('erp.jwt') || '';

function decodeClaims(token) {
  try {
    const part = token.replace(/^Bearer\s+/i, '').split('.')[1];
    const json = decodeURIComponent(atob(part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4)).split('').map(character => `%${(`00${character.charCodeAt(0).toString(16)}`).slice(-2)}`).join(''));
    return JSON.parse(json);
  } catch (error) {
    return {};
  }
}

function tokenExpired(token) {
  const exp = Number(decodeClaims(token).exp || 0);
  return exp > 0 && exp * 1000 <= Date.now() + 60000;
}

function claimRoles(claims) {
  return [...new Set([].concat(claims.roles || [], claims.role || [], claims.groups || [], claims['cognito:groups'] || [])
    .flatMap(value => String(value).replace(/^\[/, '').replace(/\]$/, '').split(/[ ,]+/))
    .filter(Boolean)
    .map(value => value.replace(/^erp:/, '').toLowerCase()))];
}

function renderActor() {
  const token = tokenValue();
  if (!token) {
    $('actorBadge').textContent = '尚未登入';
    $('roleBadges').innerHTML = '<span class="badge warn">請先登入</span>';
    $('logoutButton').disabled = true;
    return;
  }
  const claims = decodeClaims(token);
  const roles = claimRoles(claims);
  $('actorBadge').textContent = claims.sub || claims.username || '登入使用者';
  $('roleBadges').innerHTML = roles.length
    ? roles.map(role => `<span class="badge">${esc(role)}</span>`).join('')
    : '<span class="badge warn">未取得角色</span>';
  $('logoutButton').disabled = false;
}

function renderHealth(ok, message) {
  $('healthDot').classList.toggle('error', !ok);
  $('healthText').textContent = message;
}

function renderDataError(message) {
  const safe = esc(message);
  $('orders').innerHTML = `<tr><td colspan="5" class="empty">${safe}</td></tr>`;
  $('inventory').innerHTML = `<tr><td colspan="5" class="empty">${safe}</td></tr>`;
  $('transactions').innerHTML = `<div class="empty">${safe}</div>`;
  $('orderPageInfo').textContent = '—';
  $('inventoryPageInfo').textContent = '—';
  $('orderNext').disabled = true;
  $('inventoryNext').disabled = true;
  ['totalOrders', 'pendingReceipts', 'completedReceipts', 'exceptionCount', 'lowStockCount', 'quarantineTotal', 'orderCount', 'inventoryCount']
    .forEach(id => { $(id).textContent = '—'; });
}

function authErrorMessage(error) {
  if (error.status === 401) return '登入已失效，請重新使用 Cognito 登入。';
  if (error.status === 403) return '目前角色沒有執行此操作的權限。';
  return error.message || 'API 請求失敗，請稍後再試。';
}

function renderAuthRequired(message = '請使用 Cognito 登入，再載入 ERP 資料。') {
  renderHealth(true, 'API 已連線，請登入');
  renderDataError(message);
  setResult('poResult', esc(message), 'error');
}

function clearAuth() {
  resetAiChat();
  localStorage.removeItem('erp.id_token');
  localStorage.removeItem('erp.refresh_token');
  localStorage.removeItem('erp.expires_at');
  sessionStorage.removeItem('erp.jwt');
}

async function loadAuthConfig() {
  if (auth.config) return auth.config;
  const response = await fetch('/auth/config', { headers: { Accept: 'application/json' } });
  const data = await response.json();
  auth.config = data;
  return data;
}

function saveTokens(data) {
  if (data.id_token) localStorage.setItem('erp.id_token', data.id_token);
  if (data.refresh_token) localStorage.setItem('erp.refresh_token', data.refresh_token);
  const expiresIn = Number(data.expires_in || 3600);
  localStorage.setItem('erp.expires_at', String(Date.now() + Math.max(expiresIn - 60, 60) * 1000));
}

async function refreshSession() {
  if (auth.refreshPromise) return auth.refreshPromise;
  auth.refreshPromise = (async () => {
    const refreshToken = oauthToken('refresh_token');
    if (!refreshToken) return false;
    const config = await loadAuthConfig();
    if (!config.enabled) return false;
    const response = await fetch(config.token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.client_id, refresh_token: refreshToken }),
    });
    if (!response.ok) return false;
    saveTokens(await response.json());
    return Boolean(oauthToken('id_token'));
  })().catch(() => false).finally(() => { auth.refreshPromise = null; });
  return auth.refreshPromise;
}

async function validToken() {
  const token = tokenValue();
  if (token && !tokenExpired(token)) return token;
  if (await refreshSession()) return tokenValue();
  return '';
}

function apiHeaders(extra, token) {
  const headers = new Headers(extra || {});
  headers.set('Accept', 'application/json');
  headers.set('X-Request-Id', newKey('ui'));
  if (token) headers.set('Authorization', token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`);
  return headers;
}

async function api(path, options = {}) {
  const token = await validToken();
  if (!token) {
    const failure = new Error('請先使用 Cognito 登入');
    failure.status = 401;
    return Promise.reject(failure);
  }
  const requestOptions = { ...options, headers: apiHeaders(options.headers || {}, token) };
  if (requestOptions.body && typeof requestOptions.body !== 'string') {
    requestOptions.headers.set('Content-Type', 'application/json');
    requestOptions.body = JSON.stringify(requestOptions.body);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), path === '/api/ai/chat' ? 29000 : 15000);
  requestOptions.signal = controller.signal;
  try {
    const response = await fetch(path, requestOptions);
    const raw = await response.text();
    const data = raw ? await Promise.resolve().then(() => JSON.parse(raw)).catch(() => ({ detail: raw || 'API 回應格式無效' })) : {};
    if (!response.ok) {
      const failure = new Error(data.detail || data.message || `API 請求失敗（${response.status}）`);
      failure.status = response.status;
      if (response.status === 401 && !options.retryAuth && await refreshSession()) return api(path, { ...options, retryAuth: true });
      return Promise.reject(failure);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('API 請求逾時，請稍後再試');
      timeoutError.status = 408;
      return Promise.reject(timeoutError);
    }
    return Promise.reject(error);
  } finally {
    clearTimeout(timeout);
  }
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

async function beginLogin() {
  const config = await loadAuthConfig();
  if (!config.enabled) {
    setResult('poResult', 'Cognito Hosted UI 尚未部署，請先套用 Terraform。', 'error');
    return;
  }
  const verifier = randomValue();
  const stateValue = randomValue(16);
  sessionStorage.setItem('erp.pkce', JSON.stringify({ verifier, state: stateValue }));
  const challenge = await codeChallenge(verifier);
  const query = new URLSearchParams({
    client_id: config.client_id,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: config.redirect_uri,
    state: stateValue,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  window.location.assign(`${config.authorize_url}?${query}`);
}

async function completeLogin() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;
  const saved = JSON.parse(sessionStorage.getItem('erp.pkce') || '{}');
  const config = await loadAuthConfig();
  if (!saved.verifier || !saved.state || saved.state !== params.get('state')) {
    setResult('poResult', '登入回呼驗證失敗，請重新登入。', 'error');
    return false;
  }
  const response = await fetch(config.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.client_id, code, redirect_uri: config.redirect_uri, code_verifier: saved.verifier }),
  });
  if (!response.ok) {
    setResult('poResult', 'Cognito 登入交換 Token 失敗，請重新登入。', 'error');
    return false;
  }
  saveTokens(await response.json());
  sessionStorage.removeItem('erp.pkce');
  window.history.replaceState({}, document.title, window.location.pathname);
  return true;
}

async function logout() {
  const config = await loadAuthConfig().catch(() => ({ enabled: false }));
  clearAuth();
  renderActor();
  if (config.enabled) {
    const query = new URLSearchParams({ client_id: config.client_id, logout_uri: config.redirect_uri });
    window.location.assign(`${config.logout_url}?${query}`);
    return;
  }
  refresh();
}

function statusClass(status) {
  if (status === '待處理異常' || status === '差異結案') return 'alert';
  if (status === '待驗收' || status === '待補貨') return 'pending';
  return '';
}

function orderStatusHint(order) {
  const savedReasons = Array.isArray(order.exception_reasons)
    ? order.exception_reasons.filter(Boolean)
    : [];
  const inferredReasons = (order.items || []).flatMap(item => {
    const difference = Number(item.received_quantity || 0) - Number(item.ordered_quantity || 0);
    if (difference > 0) return [`${item.material_name} 超收 ${difference} ${item.unit || 'pcs'}`];
    if (difference < 0) return [`${item.material_name} 尚待補貨 ${Math.abs(difference)} ${item.unit || 'pcs'}`];
    return [];
  });
  const reasons = savedReasons.length ? savedReasons : inferredReasons;
  const hasResolution = order.exception_action || order.exception_note;
  if (order.status === '待處理異常') {
    const details = reasons.length ? `異常原因：${reasons.join('；')}` : '尚未提供異常原因。';
    return `${details}\n請至右側「異常處置」選擇處理方式。`;
  }
  if (hasResolution) {
    return `處置方式：${order.exception_action || '—'}\n處置說明：${order.exception_note || '—'}`;
  }
  return '';
}

function renderOrderStatus(order) {
  const hint = orderStatusHint(order);
  const status = `<span class="status ${statusClass(order.status)}">${esc(order.status)}</span>`;
  if (!hint) return status;
  return `<span class="status-with-hint" title="${esc(hint)}" tabindex="0" aria-label="${esc(hint)}">${status}<span class="status-hint-icon" aria-hidden="true">ⓘ</span></span>`;
}

function renderKpis(dashboard) {
  $('totalOrders').textContent = dashboard.total_purchase_orders ?? '—';
  $('pendingReceipts').textContent = dashboard.pending_receipts ?? '—';
  $('completedReceipts').textContent = dashboard.completed_receipts ?? '—';
  $('exceptionCount').textContent = dashboard.exception_count ?? '—';
  $('lowStockCount').textContent = dashboard.low_stock_count ?? '—';
  $('quarantineTotal').textContent = dashboard.quarantine_total ?? '—';
  $('inventoryCount').textContent = `${state.inventory.length} 筆`;
  $('orderCount').textContent = `${state.orders.length} 筆`;
}

function renderOrders() {
  $('orders').innerHTML = state.orders.length ? state.orders.map(order => {
    const ordered = order.items.reduce((total, item) => total + item.ordered_quantity, 0);
    const received = order.items.reduce((total, item) => total + item.received_quantity, 0);
    return `<tr><td><strong>${esc(order.po_id)}</strong></td><td>${esc(order.supplier_name)}</td><td>${esc(order.expected_date)}</td><td>${renderOrderStatus(order)}</td><td>${received} / ${ordered} ${esc(order.items[0]?.unit || 'pcs')}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">目前沒有符合條件的採購單</td></tr>';
  $('orderPageInfo').textContent = state.orderCursor ? '已載入目前頁面 · 可繼續往後' : `${state.orders.length} 筆目前結果`;
  $('orderNext').disabled = !state.orderCursor;
}

function renderInventory() {
  $('inventory').innerHTML = state.inventory.length ? state.inventory.map(item => {
    const low = item.quantity < item.reorder_point;
    return `<tr><td><strong>${esc(item.material_id)}</strong><br><span class="help">${esc(item.material_name)}</span></td><td><strong>${item.quantity}</strong> ${esc(item.unit)}</td><td><strong class="${item.quarantine_quantity ? 'amount negative' : ''}">${item.quarantine_quantity || 0}</strong> ${esc(item.unit)}</td><td>${item.reorder_point} ${esc(item.unit)}</td><td><span class="status ${low ? 'alert' : ''}">${low ? '低庫存' : '正常'}</span></td></tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">目前沒有符合條件的庫存</td></tr>';
  $('inventoryPageInfo').textContent = state.inventoryCursor ? '已載入目前頁面 · 可繼續往後' : `${state.inventory.length} 筆目前結果`;
  $('inventoryNext').disabled = !state.inventoryCursor;
}

function renderTransactions() {
  $('transactions').innerHTML = state.transactions.length ? state.transactions.slice(0, 20).map(transaction => {
    const positive = transaction.quantity_change >= 0;
    return `<div class="transaction"><div><strong>${esc(transaction.material_name)} <span class="badge">${esc(transaction.transaction_type)}</span></strong><div class="transaction-meta">${esc(transaction.material_id)} · ${esc(transaction.reference_id)} · ${esc(transaction.performed_by)} · ${formatDateTime(transaction.occurred_at)}</div></div><span class="amount ${positive ? 'positive' : 'negative'}">${positive ? '+' : ''}${transaction.quantity_change}</span></div>`;
  }).join('') : '<div class="empty">尚無庫存異動</div>';
}

function populateActions() {
  const receivable = state.allOrders.filter(order => ['待驗收', '待補貨'].includes(order.status));
  const exceptions = state.allOrders.filter(order => order.status === '待處理異常');
  $('receiptPo').innerHTML = receivable.length ? receivable.map(order => `<option value="${esc(order.po_id)}">${esc(order.po_id)} · ${esc(order.supplier_name)} · ${esc(order.status)}</option>`).join('') : '<option value="">目前沒有可收料 PO</option>';
  $('resolutionPo').innerHTML = exceptions.length ? exceptions.map(order => `<option value="${esc(order.po_id)}">${esc(order.po_id)} · ${esc(order.supplier_name)}</option>`).join('') : '<option value="">目前沒有待處理異常</option>';
  $('receiptSubmit').disabled = !receivable.length;
  $('resolutionSubmit').disabled = !exceptions.length;
  $('adjustmentMaterial').innerHTML = state.inventory.length ? state.inventory.map(item => `<option value="${esc(item.material_id)}">${esc(item.material_id)} · ${esc(item.material_name)}（可用 ${item.quantity}）</option>`).join('') : '<option value="">目前沒有庫存</option>';
  renderReceiptItems();
}

function renderReceiptItems() {
  const order = state.allOrders.find(item => item.po_id === $('receiptPo').value);
  $('receiptItems').innerHTML = order ? order.items.map(item => {
    const remaining = Math.max(item.ordered_quantity - item.received_quantity, 0);
    return `<label>${esc(item.material_name)} · 剩餘 ${remaining} / 訂購 ${item.ordered_quantity} ${esc(item.unit)}</label><input class="receipt-quantity" data-material="${esc(item.material_id)}" type="number" min="0" max="1000000000" value="${remaining}" required>`;
  }).join('') : '<p class="help">請先建立或載入可收料 PO。</p>';
}

async function loadOrders(reset) {
  if (reset) state.orderCursor = null;
  const params = new URLSearchParams({ limit: '50' });
  if (state.orderFilters.status) params.set('status', state.orderFilters.status);
  if (state.orderFilters.supplier) params.set('supplier_name', state.orderFilters.supplier);
  if (state.orderCursor) params.set('cursor', state.orderCursor);
  const page = await api(`/api/v2/purchase-orders?${params}`);
  state.orders = page.items || [];
  state.orderCursor = page.next_cursor || null;
  renderOrders();
}

async function loadInventory(reset) {
  if (reset) state.inventoryCursor = null;
  const params = new URLSearchParams({ limit: '50' });
  if (state.inventoryFilters.material) params.set('material_id', state.inventoryFilters.material);
  if (state.inventoryFilters.low) params.set('low_stock', 'true');
  if (state.inventoryCursor) params.set('cursor', state.inventoryCursor);
  const page = await api(`/api/v2/inventory?${params}`);
  state.inventory = page.items || [];
  state.inventoryCursor = page.next_cursor || null;
  renderInventory();
}

async function loadTransactions() {
  const transactions = await api('/api/inventory-transactions');
  state.transactions = (transactions || []).sort((left, right) =>
    new Date(right.occurred_at).getTime() - new Date(left.occurred_at).getTime()
  );
  renderTransactions();
}

async function refresh() {
  renderActor();
  if (!await validToken()) {
    renderAuthRequired();
    return;
  }
  try {
    const results = await Promise.all([api('/api/dashboard'), loadOrders(true), loadInventory(true), loadTransactions(), api('/api/purchase-orders?limit=200')]);
    state.dashboard = results[0];
    state.allOrders = results[4];
    renderKpis(state.dashboard);
    populateActions();
    renderHealth(true, 'API 已連線');
    $('lastRefresh').textContent = `最後更新 ${new Date().toLocaleTimeString('zh-TW')}`;
  } catch (error) {
    const message = authErrorMessage(error);
    if (error.status === 401) {
      clearAuth();
      $('tokenInput').value = '';
      renderActor();
    }
    renderHealth(false, message);
    renderDataError(message);
    setResult('poResult', esc(message), 'error');
  }
}

$('refreshButton').addEventListener('click', refresh);
$('transactionRefresh').addEventListener('click', () => loadTransactions().catch(error => setResult('poResult', esc(authErrorMessage(error)), 'error')));
$('orderFilter').addEventListener('click', () => { state.orderFilters = { status: $('orderStatus').value, supplier: $('orderSupplier').value.trim() }; loadOrders(true).catch(error => setResult('poResult', esc(authErrorMessage(error)), 'error')); });
$('orderReset').addEventListener('click', () => { $('orderStatus').value = ''; $('orderSupplier').value = ''; state.orderFilters = { status: '', supplier: '' }; loadOrders(true).catch(error => setResult('poResult', esc(authErrorMessage(error)), 'error')); });
$('orderNext').addEventListener('click', () => loadOrders(false).catch(error => setResult('poResult', esc(authErrorMessage(error)), 'error')));
$('inventoryFilter').addEventListener('click', () => { state.inventoryFilters = { material: $('inventoryMaterial').value.trim(), low: $('inventoryLow').checked }; loadInventory(true).catch(error => setResult('poResult', esc(authErrorMessage(error)), 'error')); });
$('inventoryReset').addEventListener('click', () => { $('inventoryMaterial').value = ''; $('inventoryLow').checked = false; state.inventoryFilters = { material: '', low: false }; loadInventory(true).catch(error => setResult('poResult', esc(authErrorMessage(error)), 'error')); });
$('inventoryNext').addEventListener('click', () => loadInventory(false).catch(error => setResult('poResult', esc(authErrorMessage(error)), 'error')));
$('receiptPo').addEventListener('change', renderReceiptItems);
$('loginButton').addEventListener('click', () => beginLogin().catch(error => setResult('poResult', esc(error.message || 'Cognito 登入無法開始。'), 'error')));
$('logoutButton').addEventListener('click', () => logout());
$('saveToken').addEventListener('click', () => { const value = $('tokenInput').value.trim(); clearAuth(); if (value) sessionStorage.setItem('erp.jwt', value); refresh(); });
$('clearToken').addEventListener('click', () => { clearAuth(); $('tokenInput').value = ''; refresh(); });
$('excelFile').addEventListener('change', () => { $('fileName').textContent = $('excelFile').files[0]?.name || '尚未選擇檔案'; });

$('poForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  setResult('poResult', '建立中…');
  try {
    const data = await api('/api/purchase-orders', { method: 'POST', body: { po_id: $('poId').value.trim(), supplier_name: $('supplier').value.trim(), expected_date: $('expectedDate').value, items: [{ material_id: $('materialId').value.trim(), material_name: $('materialName').value.trim(), ordered_quantity: Number($('orderedQuantity').value) }] } });
    setResult('poResult', `已建立 <strong>${esc(data.po_id)}</strong>，狀態為 ${esc(data.status)}。`);
    form.reset();
    setFormDefaults();
    await refresh();
  } catch (error) {
    setResult('poResult', esc(authErrorMessage(error)), 'error');
  } finally {
    button.disabled = false;
  }
});

$('receiptForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('receiptSubmit');
  button.disabled = true;
  setResult('receiptResult', '驗收寫入中…');
  try {
    const items = [...document.querySelectorAll('.receipt-quantity')].map(input => ({ material_id: input.dataset.material, received_quantity: Number(input.value) }));
    const data = await api('/api/receipts', { method: 'POST', headers: { 'Idempotency-Key': newKey('receipt') }, body: { po_id: $('receiptPo').value, items } });
    const message = data.exceptions.length ? data.exceptions.map(esc).join('<br>') : '驗收完成，可用庫存已更新。';
    setResult('receiptResult', `<strong>${esc(data.status)}</strong><br>${message}<br><span class="help">收料單：${esc(data.receipt_id)}</span>`, data.exceptions.length ? 'alert' : '');
    await refresh();
  } catch (error) {
    setResult('receiptResult', esc(authErrorMessage(error)), 'error');
  } finally {
    button.disabled = false;
  }
});

$('resolutionForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('resolutionSubmit');
  button.disabled = true;
  setResult('resolutionResult', '處置寫入中…');
  try {
    const data = await api(`/api/purchase-orders/${encodeURIComponent($('resolutionPo').value)}/exception-resolution`, { method: 'POST', body: { action: $('resolutionAction').value, resolved_by: decodeClaims(tokenValue()).sub || '登入使用者', note: $('resolutionNote').value.trim() } });
    setResult('resolutionResult', `<strong>${esc(data.po_id)}</strong> 已更新為 ${esc(data.status)}。`);
    $('resolutionNote').value = '';
    await refresh();
  } catch (error) {
    setResult('resolutionResult', esc(authErrorMessage(error)), 'error');
  } finally {
    button.disabled = false;
  }
});

$('adjustmentForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  setResult('adjustmentResult', '庫存異動寫入中…');
  try {
    const data = await api('/api/inventory-adjustments', { method: 'POST', headers: { 'Idempotency-Key': newKey('adjustment') }, body: { material_id: $('adjustmentMaterial').value, quantity_change: Number($('adjustmentQuantity').value), adjustment_type: $('adjustmentType').value, reason: $('adjustmentReason').value.trim(), performed_by: decodeClaims(tokenValue()).sub || '登入使用者' } });
    setResult('adjustmentResult', `已寫入 <strong>${esc(data.adjustment_id)}</strong>：${esc(data.quantity_before)} → ${esc(data.quantity_after)}。`);
    $('adjustmentQuantity').value = '';
    $('adjustmentReason').value = '';
    await refresh();
    const refreshedItem = state.inventory.find(item => item.material_id === data.material_id);
    if (refreshedItem) {
      refreshedItem.quantity = data.quantity_after;
      refreshedItem.updated_at = data.occurred_at;
      renderInventory();
      populateActions();
    }
  } catch (error) {
    setResult('adjustmentResult', esc(authErrorMessage(error)), 'error');
  } finally {
    button.disabled = false;
  }
});

$('importForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const file = $('excelFile').files[0];
  if (!file) return;
  button.disabled = true;
  setResult('importResult', '建立預簽名網址中…');
  try {
    const response = await api('/api/imports/excel/upload-url', { method: 'POST', body: { file_name: file.name } });
    const upload = await fetch(response.upload_url, { method: 'PUT', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: file });
    if (!upload.ok) return Promise.reject(new Error(`S3 上傳失敗（${upload.status}）`));
    setResult('importResult', `檔案已送入匯入佇列：<strong>${esc(response.object_key)}</strong><br><span class="help">worker 會非同步建立 PO；重複相同定義會自動略過。</span>`);
    form.reset();
    $('fileName').textContent = '尚未選擇檔案';
  } catch (error) {
    setResult('importResult', esc(authErrorMessage(error)), 'error');
  } finally {
    button.disabled = false;
  }
});

function setFormDefaults() {
  $('poId').value = `PO-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
  $('supplier').value = '';
  $('materialId').value = '';
  $('materialName').value = '';
  $('expectedDate').value = new Date().toISOString().slice(0, 10);
  $('orderedQuantity').value = '1';
}

async function start() {
  setFormDefaults();
  $('tokenInput').value = sessionStorage.getItem('erp.jwt') || '';
  try {
    const config = await loadAuthConfig();
    $('loginButton').disabled = !config.enabled;
    await completeLogin();
  } catch (error) {
    $('loginButton').disabled = false;
  }
  renderActor();
  await refresh();
}

const aiState = { history: [], busy: false, generation: 0 };

function resetAiChat() {
  aiState.history = [];
  aiState.generation += 1;
  $('aiLog').replaceChildren();
  $('aiStatus').textContent = '';
}

function selectWorkspace(ai) {
  $('operationsPanel').hidden = ai;
  $('aiPanel').hidden = !ai;
  for (const [id, selected] of [['aiTab', ai], ['operationsTab', !ai]]) {
    $(id).setAttribute('aria-selected', String(selected));
    $(id).tabIndex = selected ? 0 : -1;
  }
}

$('operationsTab').addEventListener('click', () => selectWorkspace(false));
$('aiTab').addEventListener('click', () => selectWorkspace(true));
for (const id of ['operationsTab', 'aiTab']) {
  $(id).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const ai = event.key === 'End' || (event.key !== 'Home' && id === 'operationsTab');
      selectWorkspace(ai);
      $(ai ? 'aiTab' : 'operationsTab').focus();
    }
  });
}
$('aiClear').addEventListener('click', resetAiChat);
document.querySelectorAll('.ai-suggestion').forEach(button => button.addEventListener('click', () => {
  $('aiMessage').value = button.textContent;
  $('aiMessage').focus();
}));

function aiMessage(role, text) {
  const entry = document.createElement('div');
  entry.className = `chat-message ${role}`;
  entry.textContent = `${role === 'user' ? '你' : 'AI 助理'}：\n${text}`;
  $('aiLog').append(entry);
  entry.scrollIntoView({ block: 'nearest' });
  return entry;
}

function showDraft(entry, draft, generation) {
  const card = document.createElement('div');
  card.className = 'chat-draft';
  const title = document.createElement('strong');
  title.textContent = `${draft.title} · 待確認`;
  const content = document.createElement('pre');
  const labels = { po_id: '採購單', supplier_name: '供應商', expected_date: '預計到貨',
    material_id: '料號', material_name: '品名', ordered_quantity: '訂購數量',
    received_quantity: '本次實收', unit: '單位', received_by: '收料人',
    performed_by: '操作者', resolved_by: '處置人', quantity_change: '異動數量',
    adjustment_type: '異動類型', reason: '原因', action: '處置方式', note: '說明' };
  const describe = object => Object.entries(object).map(([field, value]) => field === 'items'
    ? `品項：\n${value.map((item, index) => `${index + 1}. ${describe(item)}`).join('\n')}`
    : `${labels[field] || field}：${String(value)}`).join('\n');
  content.textContent = describe(draft.payload);
  const confirm = document.createElement('button');
  confirm.type = 'button'; confirm.className = 'button primary'; confirm.textContent = '確認送出';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'button'; cancel.textContent = '取消';
  const result = document.createElement('p');
  const key = newKey('ai-operation');
  cancel.addEventListener('click', () => {
    confirm.disabled = true; cancel.disabled = true; result.textContent = '已取消，未送出。';
  });
  confirm.addEventListener('click', async () => {
    if (generation !== aiState.generation) return;
    const allowed = ['/api/purchase-orders', '/api/receipts', '/api/inventory-adjustments'];
    if (!allowed.includes(draft.path) && !/^\/api\/purchase-orders\/[^/]+\/exception-resolution$/.test(draft.path)) return;
    confirm.disabled = true; cancel.disabled = true; result.textContent = '正在送出…';
    try {
      const data = await api(draft.path, { method: 'POST', body: draft.payload,
        headers: draft.requires_idempotency ? { 'Idempotency-Key': key } : {} });
      if (generation !== aiState.generation) return;
      title.textContent = `${draft.title} · 已完成`;
      result.textContent = JSON.stringify(data, null, 2);
      await refresh();
    } catch (error) {
      if (generation !== aiState.generation) return;
      result.textContent = authErrorMessage(error);
      // Reuse the operation key when retrying an uncertain response.
      confirm.disabled = false; cancel.disabled = false; confirm.textContent = '重新送出';
    }
  });
  card.append(title, content, confirm, cancel, result); entry.append(card);
}

$('aiForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (aiState.busy) return;
  const message = $('aiMessage').value.trim();
  if (!message) return;
  const generation = aiState.generation;
  aiState.busy = true; $('aiSend').disabled = true;
  $('aiStatus').textContent = '正在查詢與整理資料…';
  aiMessage('user', message); $('aiMessage').value = '';
  try {
    const response = await api('/api/ai/chat', { method: 'POST', body: { message, history: aiState.history.slice(-8) } });
    if (generation !== aiState.generation) return;
    const entry = aiMessage('assistant', response.answer);
    if (response.sources.length) {
      const details = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = '查看本次查詢來源';
      const data = document.createElement('pre'); data.textContent = JSON.stringify(response.sources, null, 2);
      details.append(summary, data); entry.append(details);
    }
    response.drafts.forEach(draft => showDraft(entry, draft, generation));
    aiState.history.push({ role: 'user', content: message }, { role: 'assistant', content: response.answer.slice(0, 6000) });
    aiState.history = aiState.history.slice(-8);
    $('aiStatus').textContent = '回答已完成。請核對查詢來源與操作內容。';
  } catch (error) {
    if (generation === aiState.generation) {
      aiMessage('assistant', authErrorMessage(error));
      $('aiMessage').value = message; $('aiStatus').textContent = '未取得回答，可重新送出。';
    }
  } finally {
    aiState.busy = false; $('aiSend').disabled = false;
  }
});

start();

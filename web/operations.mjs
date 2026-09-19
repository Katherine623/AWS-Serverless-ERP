import { api, authErrorMessage } from './api.mjs';
import { clearTokens, decodeClaims, renderActor, session, tokenValue, validToken } from './auth.mjs';
import { $, el, formatDateTime, newKey, replaceRows, setResult } from './ui.mjs';

const RECEIVABLE_STATUSES = ['待驗收', '待補貨'];
const ACTION_STATUSES = ['待驗收', '待補貨', '待處理異常'];
const PENDING_KINDS = ['receipt', 'adjustment'];

const JOB_STATUS = {
  awaiting_upload: '等待上傳',
  processing: '處理中',
  completed: '完成',
  partial_failed: '部分資料失敗',
  failed: '失敗／等待重試',
  draft: '待確認',
  executing: '執行中／結果待確認',
  cancelled: '已取消',
};

export const state = { orders: [], inventory: [], allOrders: [], actionCursors: {} };
const filters = { orderStatus: '', orderSupplier: '', inventoryMaterial: '', inventoryLow: false };

export const jobStatusLabel = status => JOB_STATUS[status] || status;

const report = (resultId, error) => setResult(resultId, authErrorMessage(error), 'error');
const guard = (resultId, promise) => promise.catch(error => report(resultId, error));

// --- pending operation bookkeeping -----------------------------------------

function operationStorageKey(kind) {
  const owner = decodeClaims(tokenValue()).sub;
  if (!owner) throw new Error('無法取得操作者，請重新登入。');
  return `erp.pending.${owner}.${kind}`;
}

export function syncPendingBars() {
  for (const kind of PENDING_KINDS) {
    let pending = false;
    try {
      pending = Boolean(sessionStorage.getItem(operationStorageKey(kind)));
    } catch {
      pending = false;
    }
    $(`${kind}Pending`).hidden = !pending;
  }
}

async function submitOperation(kind, path, body) {
  const storageKey = operationStorageKey(kind);
  const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
  const fingerprint = JSON.stringify(body);
  if (saved && saved.fingerprint !== fingerprint) {
    throw new Error('上一筆操作結果尚未確認。請先重送上一筆，或查核帳本後清除待確認操作。');
  }
  const operation = saved || { path, body, fingerprint, key: newKey(kind) };
  sessionStorage.setItem(storageKey, JSON.stringify(operation));
  syncPendingBars();
  try {
    const result = await api(path, { method: 'POST', body, headers: { 'Idempotency-Key': operation.key } });
    sessionStorage.removeItem(storageKey);
    return result;
  } finally {
    syncPendingBars();
  }
}

async function retryOperation(kind) {
  const saved = JSON.parse(sessionStorage.getItem(operationStorageKey(kind)) || 'null');
  if (!saved) throw new Error('沒有待確認操作。');
  return submitOperation(kind, saved.path, saved.body);
}

// --- cursor pagination ------------------------------------------------------

function createList(prefix, fetchPage, render) {
  const view = { history: [], cursor: null, next: null, items: [] };

  async function load() {
    const page = await fetchPage(view.cursor);
    view.items = page.items || [];
    view.next = page.next_cursor || null;
    render(view.items);
    $(`${prefix}Prev`).disabled = view.history.length === 0;
    $(`${prefix}Next`).disabled = !view.next;
    $(`${prefix}PageInfo`).textContent = `第 ${view.history.length + 1} 頁 · ${view.items.length} 筆`;
  }

  return {
    view,
    reset() {
      view.history = [];
      view.cursor = null;
      return load();
    },
    next() {
      view.history.push(view.cursor);
      view.cursor = view.next;
      return load();
    },
    prev() {
      view.cursor = view.history.pop() ?? null;
      return load();
    },
  };
}

function pageParams(cursor, extra = {}) {
  const params = new URLSearchParams({ limit: '50', ...extra });
  if (cursor) params.set('cursor', cursor);
  return params;
}

const orders = createList(
  'order',
  cursor => {
    const extra = {};
    if (filters.orderStatus) extra.status = filters.orderStatus;
    if (filters.orderSupplier) extra.supplier_name = filters.orderSupplier;
    return api(`/api/v2/purchase-orders?${pageParams(cursor, extra)}`);
  },
  items => {
    state.orders = items;
    renderOrders(items);
    $('orderCount').textContent = `${items.length} 筆`;
  },
);

const inventory = createList(
  'inventory',
  cursor => {
    const extra = {};
    if (filters.inventoryMaterial) extra.material_id = filters.inventoryMaterial;
    if (filters.inventoryLow) extra.low_stock = 'true';
    return api(`/api/v2/inventory?${pageParams(cursor, extra)}`);
  },
  items => {
    state.inventory = items;
    renderInventory(items);
    $('inventoryCount').textContent = `${items.length} 筆`;
    populateActions();
  },
);

const transactions = createList(
  'transaction',
  cursor => api(`/api/v2/inventory-transactions?${pageParams(cursor)}`),
  items => renderTransactions(items),
);

// --- rendering --------------------------------------------------------------

function statusClass(status) {
  if (status === '待處理異常' || status === '差異結案') return 'alert';
  if (status === '待驗收' || status === '待補貨') return 'pending';
  return '';
}

function orderStatusHint(order) {
  const savedReasons = Array.isArray(order.exception_reasons) ? order.exception_reasons.filter(Boolean) : [];
  const inferredReasons = (order.items || []).flatMap(item => {
    const difference = Number(item.received_quantity || 0) - Number(item.ordered_quantity || 0);
    if (difference > 0) return [`${item.material_name} 超收 ${difference} ${item.unit || 'pcs'}`];
    if (difference < 0) return [`${item.material_name} 尚待補貨 ${Math.abs(difference)} ${item.unit || 'pcs'}`];
    return [];
  });
  const reasons = savedReasons.length ? savedReasons : inferredReasons;
  if (order.status === '待處理異常') {
    const details = reasons.length ? `異常原因：${reasons.join('；')}` : '尚未提供異常原因。';
    return `${details}\n請至右側「異常處置」選擇處理方式。`;
  }
  if (order.exception_action || order.exception_note) {
    return `處置方式：${order.exception_action || '—'}\n處置說明：${order.exception_note || '—'}`;
  }
  return '';
}

function renderOrderStatus(order) {
  const badge = el('span', { className: `status ${statusClass(order.status)}`.trim(), textContent: order.status });
  const hint = orderStatusHint(order);
  if (!hint) return badge;
  return el(
    'span',
    { className: 'status-with-hint', title: hint, tabindex: '0', 'aria-label': hint },
    badge,
    el('span', { className: 'status-hint-icon', 'aria-hidden': 'true', textContent: 'ⓘ' }),
  );
}

function renderOrders(items) {
  replaceRows(
    'orders',
    items.map(order => {
      const ordered = order.items.reduce((total, item) => total + item.ordered_quantity, 0);
      const received = order.items.reduce((total, item) => total + item.received_quantity, 0);
      return el(
        'tr',
        {},
        el('td', {}, el('strong', { textContent: order.po_id })),
        el('td', { textContent: order.supplier_name }),
        el('td', { textContent: order.expected_date }),
        el('td', {}, renderOrderStatus(order)),
        el('td', { textContent: `${received} / ${ordered} ${order.items[0]?.unit || 'pcs'}` }),
      );
    }),
    5,
    '目前沒有符合條件的採購單',
  );
}

function renderInventory(items) {
  replaceRows(
    'inventory',
    items.map(item => {
      const low = item.quantity < item.reorder_point;
      return el(
        'tr',
        {},
        el(
          'td',
          {},
          el('strong', { textContent: item.material_id }),
          el('br'),
          el('span', { className: 'help', textContent: item.material_name }),
        ),
        el('td', {}, el('strong', { textContent: String(item.quantity) }), ` ${item.unit}`),
        el(
          'td',
          {},
          el('strong', {
            className: item.quarantine_quantity ? 'amount negative' : '',
            textContent: String(item.quarantine_quantity || 0),
          }),
          ` ${item.unit}`,
        ),
        el('td', { textContent: `${item.reorder_point} ${item.unit}` }),
        el(
          'td',
          {},
          el('span', { className: `status ${low ? 'alert' : ''}`.trim(), textContent: low ? '低庫存' : '正常' }),
        ),
      );
    }),
    5,
    '目前沒有符合條件的庫存',
  );
}

function renderTransactions(items) {
  const sorted = [...items].sort(
    (left, right) => new Date(right.occurred_at).getTime() - new Date(left.occurred_at).getTime(),
  );
  $('transactions').replaceChildren(
    ...(sorted.length
      ? sorted.map(transaction => {
          const positive = transaction.quantity_change >= 0;
          return el(
            'div',
            { className: 'transaction' },
            el(
              'div',
              {},
              el(
                'strong',
                { textContent: `${transaction.material_name} ` },
                el('span', { className: 'badge', textContent: transaction.transaction_type }),
              ),
              el('div', {
                className: 'transaction-meta',
                textContent: `${transaction.material_id} · ${transaction.reference_id} · ${transaction.performed_by} · ${formatDateTime(transaction.occurred_at)}`,
              }),
            ),
            el('span', {
              className: `amount ${positive ? 'positive' : 'negative'}`,
              textContent: `${positive ? '+' : ''}${transaction.quantity_change}`,
            }),
          );
        })
      : [el('div', { className: 'empty', textContent: '尚無庫存異動' })]),
  );
}

function renderKpis(dashboard) {
  const values = {
    totalOrders: dashboard.total_purchase_orders,
    pendingReceipts: dashboard.pending_receipts,
    completedReceipts: dashboard.completed_receipts,
    exceptionCount: dashboard.exception_count,
    lowStockCount: dashboard.low_stock_count,
    quarantineTotal: dashboard.quarantine_total,
  };
  for (const [id, value] of Object.entries(values)) $(id).textContent = value ?? '—';
}

function renderDataError(message) {
  replaceRows('orders', [], 5, message);
  replaceRows('inventory', [], 5, message);
  $('transactions').replaceChildren(el('div', { className: 'empty', textContent: message }));
  for (const prefix of ['order', 'inventory', 'transaction']) {
    $(`${prefix}PageInfo`).textContent = '—';
    $(`${prefix}Prev`).disabled = true;
    $(`${prefix}Next`).disabled = true;
  }
  for (const id of ['totalOrders', 'pendingReceipts', 'completedReceipts', 'exceptionCount', 'lowStockCount', 'quarantineTotal', 'orderCount', 'inventoryCount']) {
    $(id).textContent = '—';
  }
}

function option(value, label) {
  return el('option', { value, textContent: label });
}

function populateActions() {
  const selected = {
    receipt: $('receiptPo').value,
    resolution: $('resolutionPo').value,
    material: $('adjustmentMaterial').value,
  };
  const receivable = state.allOrders.filter(order => RECEIVABLE_STATUSES.includes(order.status));
  const exceptions = state.allOrders.filter(order => order.status === '待處理異常');

  $('receiptPo').replaceChildren(
    ...(receivable.length
      ? receivable.map(order => option(order.po_id, `${order.po_id} · ${order.supplier_name} · ${order.status}`))
      : [option('', '目前沒有可收料 PO')]),
  );
  $('resolutionPo').replaceChildren(
    ...(exceptions.length
      ? exceptions.map(order => option(order.po_id, `${order.po_id} · ${order.supplier_name}`))
      : [option('', '目前沒有待處理異常')]),
  );
  $('adjustmentMaterial').replaceChildren(
    ...(state.inventory.length
      ? state.inventory.map(item =>
          option(item.material_id, `${item.material_id} · ${item.material_name}（可用 ${item.quantity}）`),
        )
      : [option('', '目前沒有庫存')]),
  );

  $('receiptSubmit').disabled = !receivable.length;
  $('resolutionSubmit').disabled = !exceptions.length;
  if (receivable.some(order => order.po_id === selected.receipt)) $('receiptPo').value = selected.receipt;
  if (exceptions.some(order => order.po_id === selected.resolution)) $('resolutionPo').value = selected.resolution;
  if (state.inventory.some(item => item.material_id === selected.material)) {
    $('adjustmentMaterial').value = selected.material;
  }
  renderReceiptItems();
}

function renderReceiptItems() {
  const order = state.allOrders.find(item => item.po_id === $('receiptPo').value);
  if (!order) {
    $('receiptItems').replaceChildren(el('p', { className: 'help', textContent: '請先建立或載入可收料 PO。' }));
    return;
  }
  $('receiptItems').replaceChildren(
    ...order.items.flatMap(item => {
      const remaining = Math.max(item.ordered_quantity - item.received_quantity, 0);
      const inputId = `receipt-${item.material_id}`;
      return [
        el('label', {
          for: inputId,
          textContent: `${item.material_name} · 剩餘 ${remaining} / 訂購 ${item.ordered_quantity} ${item.unit}`,
        }),
        el('input', {
          id: inputId,
          className: 'receipt-quantity',
          dataset: { material: item.material_id },
          type: 'number',
          min: '0',
          max: '1000000000',
          value: String(remaining),
          required: 'required',
        }),
      ];
    }),
  );
}

// --- loaders ----------------------------------------------------------------

async function loadActionOrders(reset = true) {
  if (reset) {
    state.allOrders = [];
    state.actionCursors = {};
  }
  const targets = ACTION_STATUSES.filter(status => reset || state.actionCursors[status]);
  const pages = await Promise.all(
    targets.map(status =>
      api(`/api/v2/purchase-orders?${pageParams(state.actionCursors[status], { status })}`).then(page => [status, page]),
    ),
  );
  const byId = new Map(state.allOrders.map(order => [order.po_id, order]));
  for (const [status, page] of pages) {
    state.actionCursors[status] = page.next_cursor;
    (page.items || []).forEach(order => byId.set(order.po_id, order));
  }
  state.allOrders = [...byId.values()];
  $('actionMore').hidden = !Object.values(state.actionCursors).some(Boolean);
  populateActions();
}

function renderImportJob(job) {
  const errors = (job.errors || [])
    .map(error => `${error.row ? `第 ${error.row} 列 ` : ''}${error.po_id || ''} ${error.message}`)
    .join('\n');
  return el('div', {
    className: 'chat-message',
    textContent:
      `${job.file_name || job.object_key} · ${jobStatusLabel(job.status)}\n` +
      `新增 ${job.imported || 0} 張，略過 ${job.skipped || 0} 張，失敗 ${job.failed || 0} 筆\n${errors}`,
  });
}

async function loadImportJobs() {
  const generation = session.generation;
  const jobs = await api('/api/imports/excel/jobs');
  if (generation !== session.generation) return;
  $('importJobs').replaceChildren(
    ...(jobs.length ? jobs.map(renderImportJob) : [el('p', { className: 'help', textContent: '尚無匯入紀錄。' })]),
  );
}

async function watchImport(identifier) {
  const generation = session.generation;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (generation !== session.generation) return;
    try {
      const job = await api(`/api/imports/excel/jobs/${encodeURIComponent(identifier)}`);
      if (generation !== session.generation) return;
      $('importJobs').replaceChildren(renderImportJob(job));
      if (['completed', 'partial_failed', 'failed'].includes(job.status)) {
        if (job.status !== 'failed') await refresh();
        return;
      }
    } catch (error) {
      $('importJobs').replaceChildren(el('p', { className: 'help', textContent: authErrorMessage(error) }));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

export async function refresh() {
  renderActor();
  if (!(await validToken())) {
    renderHealth(true, 'API 已連線，請登入');
    renderDataError('請使用 Cognito 登入，再載入 ERP 資料。');
    setResult('authResult', '請使用 Cognito 登入，再載入 ERP 資料。', 'error');
    return;
  }
  try {
    const [dashboard] = await Promise.all([
      api('/api/dashboard'),
      orders.reset(),
      inventory.reset(),
      transactions.reset(),
      loadActionOrders(true),
    ]);
    renderKpis(dashboard);
    populateActions();
    renderHealth(true, 'API 已連線');
    setResult('authResult', '');
    $('lastRefresh').textContent = `最後更新 ${new Date().toLocaleTimeString('zh-TW')}`;
    loadImportJobs().catch(() => {});
  } catch (error) {
    const message = authErrorMessage(error);
    if (error.status === 401) {
      clearTokens();
      renderActor();
    }
    renderHealth(false, message);
    renderDataError(message);
    setResult('authResult', message, 'error');
  }
}

function renderHealth(ok, message) {
  $('healthDot').classList.toggle('error', !ok);
  $('healthText').textContent = message;
}

// --- form handlers ----------------------------------------------------------

function setFormDefaults() {
  $('poId').value = `PO-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
  $('supplier').value = '';
  $('materialId').value = '';
  $('materialName').value = '';
  $('expectedDate').value = new Date().toISOString().slice(0, 10);
  $('orderedQuantity').value = '1';
}

async function withButton(button, action) {
  button.disabled = true;
  try {
    await action();
  } finally {
    button.disabled = false;
  }
}

function applyOrderFilters() {
  filters.orderStatus = $('orderStatus').value;
  filters.orderSupplier = $('orderSupplier').value.trim();
  $('orderReset').hidden = !(filters.orderStatus || filters.orderSupplier);
  return guard('orderResult', orders.reset());
}

function applyInventoryFilters() {
  filters.inventoryMaterial = $('inventoryMaterial').value.trim();
  filters.inventoryLow = $('inventoryLow').checked;
  $('inventoryReset').hidden = !(filters.inventoryMaterial || filters.inventoryLow);
  return guard('inventoryResult', inventory.reset());
}

function bindEvents() {
  $('refreshButton').addEventListener('click', () => refresh());
  $('orderFilter').addEventListener('click', applyOrderFilters);
  $('orderSupplier').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyOrderFilters();
    }
  });
  $('orderReset').addEventListener('click', () => {
    $('orderStatus').value = '';
    $('orderSupplier').value = '';
    applyOrderFilters();
  });
  $('orderPrev').addEventListener('click', () => guard('orderResult', orders.prev()));
  $('orderNext').addEventListener('click', () => guard('orderResult', orders.next()));

  $('inventoryFilter').addEventListener('click', applyInventoryFilters);
  $('inventoryMaterial').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyInventoryFilters();
    }
  });
  $('inventoryReset').addEventListener('click', () => {
    $('inventoryMaterial').value = '';
    $('inventoryLow').checked = false;
    applyInventoryFilters();
  });
  $('inventoryPrev').addEventListener('click', () => guard('inventoryResult', inventory.prev()));
  $('inventoryNext').addEventListener('click', () => guard('inventoryResult', inventory.next()));

  $('transactionPrev').addEventListener('click', () => guard('transactionResult', transactions.prev()));
  $('transactionNext').addEventListener('click', () => guard('transactionResult', transactions.next()));

  $('actionMore').addEventListener('click', () => guard('receiptResult', loadActionOrders(false)));
  $('receiptPo').addEventListener('change', renderReceiptItems);
  $('excelFile').addEventListener('change', () => {
    $('fileName').textContent = $('excelFile').files[0]?.name || '尚未選擇檔案';
  });

  $('poForm').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    withButton(form.querySelector('button'), async () => {
      setResult('poResult', '建立中…');
      try {
        const data = await api('/api/purchase-orders', {
          method: 'POST',
          body: {
            po_id: $('poId').value.trim(),
            supplier_name: $('supplier').value.trim(),
            expected_date: $('expectedDate').value,
            items: [
              {
                material_id: $('materialId').value.trim(),
                material_name: $('materialName').value.trim(),
                ordered_quantity: Number($('orderedQuantity').value),
              },
            ],
          },
        });
        setResult('poResult', `已建立 ${data.po_id}，狀態為 ${data.status}。`);
        form.reset();
        setFormDefaults();
        await refresh();
      } catch (error) {
        report('poResult', error);
      }
    });
  });

  $('receiptForm').addEventListener('submit', event => {
    event.preventDefault();
    withButton($('receiptSubmit'), async () => {
      setResult('receiptResult', '驗收寫入中…');
      try {
        const items = [...document.querySelectorAll('.receipt-quantity')].map(input => ({
          material_id: input.dataset.material,
          received_quantity: Number(input.value),
        }));
        const data = await submitOperation('receipt', '/api/receipts', { po_id: $('receiptPo').value, items });
        const detail = data.exceptions.length ? data.exceptions.join('\n') : '驗收完成，可用庫存已更新。';
        setResult(
          'receiptResult',
          `${data.status}\n${detail}\n收料單：${data.receipt_id}`,
          data.exceptions.length ? 'alert' : '',
        );
        await refresh();
      } catch (error) {
        report('receiptResult', error);
      }
    });
  });

  $('resolutionForm').addEventListener('submit', event => {
    event.preventDefault();
    withButton($('resolutionSubmit'), async () => {
      setResult('resolutionResult', '處置寫入中…');
      try {
        const data = await api(
          `/api/purchase-orders/${encodeURIComponent($('resolutionPo').value)}/exception-resolution`,
          {
            method: 'POST',
            body: {
              action: $('resolutionAction').value,
              resolved_by: decodeClaims(tokenValue()).sub || '登入使用者',
              note: $('resolutionNote').value.trim(),
            },
          },
        );
        setResult('resolutionResult', `${data.po_id} 已更新為 ${data.status}。`);
        $('resolutionNote').value = '';
        await refresh();
      } catch (error) {
        report('resolutionResult', error);
      }
    });
  });

  $('adjustmentForm').addEventListener('submit', event => {
    event.preventDefault();
    withButton(event.currentTarget.querySelector('button[type="submit"]'), async () => {
      setResult('adjustmentResult', '庫存異動寫入中…');
      try {
        const data = await submitOperation('adjustment', '/api/inventory-adjustments', {
          material_id: $('adjustmentMaterial').value,
          quantity_change: Number($('adjustmentQuantity').value),
          adjustment_type: $('adjustmentType').value,
          reason: $('adjustmentReason').value.trim(),
        });
        setResult('adjustmentResult', `已寫入 ${data.adjustment_id}：${data.quantity_before} → ${data.quantity_after}。`);
        $('adjustmentQuantity').value = '';
        $('adjustmentReason').value = '';
        await refresh();
      } catch (error) {
        report('adjustmentResult', error);
      }
    });
  });

  $('importForm').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = $('excelFile').files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setResult('importResult', 'Excel 最多 10 MB，請拆分檔案。', 'error');
      return;
    }
    withButton(form.querySelector('button[type="submit"]'), async () => {
      setResult('importResult', '建立預簽名網址中…');
      try {
        const response = await api('/api/imports/excel/upload-url', {
          method: 'POST',
          body: { file_name: file.name },
        });
        const upload = await fetch(response.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
          body: file,
        });
        if (!upload.ok) throw new Error(`S3 上傳失敗（${upload.status}）`);
        setResult(
          'importResult',
          `檔案已送入匯入佇列：${response.object_key}\nworker 會非同步建立 PO；重複相同定義會自動略過。`,
        );
        form.reset();
        $('fileName').textContent = '尚未選擇檔案';
        if (response.job_id) watchImport(response.job_id);
      } catch (error) {
        report('importResult', error);
      }
    });
  });

  for (const button of document.querySelectorAll('[data-retry-operation]')) {
    button.addEventListener('click', () =>
      withButton(button, async () => {
        const kind = button.dataset.retryOperation;
        try {
          const result = await retryOperation(kind);
          setResult(`${kind}Result`, `已確認操作結果：${result.receipt_id || result.adjustment_id}`);
          await refresh();
        } catch (error) {
          report(`${kind}Result`, error);
        }
      }),
    );
  }

  for (const button of document.querySelectorAll('[data-clear-operation]')) {
    button.addEventListener('click', () => {
      const kind = button.dataset.clearOperation;
      try {
        if (window.confirm('請先查核帳本，確認上一筆是否已成功。清除後送出將視為新操作，是否繼續？')) {
          sessionStorage.removeItem(operationStorageKey(kind));
          syncPendingBars();
        }
      } catch (error) {
        report(`${kind}Result`, error);
      }
    });
  }

  document.addEventListener('erp:signout', () => {
    $('importJobs').replaceChildren();
    syncPendingBars();
  });
}

export function initOperations() {
  setFormDefaults();
  syncPendingBars();
  bindEvents();
}

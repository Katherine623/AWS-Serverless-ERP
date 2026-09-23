import { api, authErrorMessage } from './api.mjs';
import { session, tokenValue } from './auth.mjs';
import { jobStatusLabel, refresh } from './operations.mjs';
import { $, el, formatDateTime } from './ui.mjs';

const CONFIRMABLE_PATHS = ['/api/purchase-orders', '/api/receipts', '/api/inventory-adjustments'];
const RESOLUTION_PATH = /^\/api\/purchase-orders\/[^/]+\/exception-resolution$/;
const OPEN_ACTION_STATUSES = ['draft', 'failed', 'executing'];
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const VOICE_ERRORS = {
  'no-speech': '沒有聽到聲音，請再說一次。',
  'audio-capture': '找不到麥克風，請確認裝置已連接後重試。',
  'not-allowed': '麥克風權限被拒絕，請在瀏覽器允許麥克風後重試。',
  'service-not-allowed': '瀏覽器不允許使用語音辨識服務，請檢查設定後重試。',
  'language-not-supported': '此瀏覽器不支援中文語音辨識，請改用 Chrome。',
  network: '語音辨識連線失敗，請檢查網路後重試。',
  aborted: '語音輸入已取消。',
};

const PAYLOAD_LABELS = {
  po_id: '採購單',
  supplier_name: '供應商',
  expected_date: '預計到貨',
  material_id: '料號',
  material_name: '品名',
  ordered_quantity: '訂購數量',
  received_quantity: '本次實收',
  unit: '單位',
  received_by: '收料人',
  performed_by: '操作者',
  resolved_by: '處置人',
  quantity_change: '異動數量',
  adjustment_type: '異動類型',
  reason: '原因',
  action: '處置方式',
  note: '說明',
};

const aiState = {
  history: [],
  busy: false,
  activeIntent: 'auto',
  contextMemory: {},
  pendingDraftIds: new Set(),
};
const voiceState = {
  recognition: null,
  listening: false,
  lastPartialAt: 0,
  autoStopTimer: null,
  pendingStart: false,
  manualStopRequested: false,
  restarts: 0,
};
const VOICE_MAX_RESTARTS = 3;
const VOICE_IDLE_STOP_MS = 3000;
const SIMPLE_TO_TRADITIONAL = [
  ['供应商', '供應商'],
  ['厂商', '廠商'],
  ['预计', '預計'],
  ['到货', '到貨'],
  ['料号', '料號'],
  ['品号', '品號'],
  ['数量', '數量'],
  ['采购', '採購'],
  ['单号', '單號'],
  ['为', '為'],
  ['号', '號'],
  ['台积电', '台積電'],
];
const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };
const WRITE_INTENTS = new Set(['create_purchase_order', 'receive', 'adjust_inventory', 'resolve_exception']);
const INTENT_CONFIG = {
  auto: {
    label: '自動判斷',
    referenceLabel: '關聯資訊',
    referenceType: 'free',
    requiredReference: false,
    messagePlaceholder: '例如：我有什麼收料單要處理？或 建立採購單，供應商台積電，料號 MAT-1001，數量 250 個',
    helpText: '可先問有哪些待處理項目；確認對象後，再補單號、料號、數量或處置方式。',
  },
  query: {
    label: '查詢 / 說明',
    referenceLabel: '單號 / 料號',
    referenceType: 'free',
    requiredReference: false,
    messagePlaceholder: '例如：查詢 MAT-1001 的庫存，並說明是否需要補貨',
    helpText: '查詢 / 說明：可直接描述想查的庫存、採購單、異常或 KPI。',
  },
  create_purchase_order: {
    label: '建立採購單',
    referenceLabel: '採購單號',
    referenceType: 'po',
    requiredReference: true,
    messagePlaceholder: '例如：採購單號 PO-2026-001，供應商台積電，預計到貨 9 月 23 日，料號 MAT-1001，品名 控制晶片，數量 250 個',
    helpText: '建立採購單：可直接描述要建立的採購需求；若資料不完整，AI 會再追問採購單號、供應商、到貨日、料號、品名、數量。',
  },
  receive: {
    label: '收料單',
    referenceLabel: '採購單號',
    referenceType: 'po',
    requiredReference: true,
    messagePlaceholder: '例如：採購單號 PO-2026-001，本次收料 MAT-1001 250 個、MAT-1002 40 個',
    helpText: '收料單：可先問有哪些待處理收料；要送草稿時，再補採購單號與各品項本次實收數量。',
  },
  adjust_inventory: {
    label: '庫存調整 / 退貨 / 報廢',
    referenceLabel: '料號',
    referenceType: 'material',
    requiredReference: true,
    messagePlaceholder: '例如：料號 MAT-1001，盤點調整，數量 -5，原因 外箱破損',
    helpText: '庫存調整 / 退貨 / 報廢：可先問有哪些料需要處理；要送草稿時，再補料號、類型、數量、原因。',
  },
  resolve_exception: {
    label: '異常處置',
    referenceLabel: '採購單號',
    referenceType: 'po',
    requiredReference: true,
    messagePlaceholder: '例如：採購單號 PO-2026-001，差異允收結案，說明 供應商確認短缺不補貨',
    helpText: '異常處置：可先問有哪些異常單要處理；要送草稿時，再補採購單號、處置方式、說明。',
  },
};
const INTENT_MEMORY_FIELDS = {
  create_purchase_order: ['po_id', 'supplier_name', 'expected_date', 'material_id', 'material_name', 'quantity'],
  receive: ['po_id', 'material_id', 'quantity'],
  adjust_inventory: ['material_id', 'adjustment_type', 'quantity', 'reason'],
  resolve_exception: ['po_id', 'action', 'note'],
};
const INTENT_FIELD_LABELS = {
  po_id: '採購單號',
  supplier_name: '供應商',
  expected_date: '到貨日',
  material_id: '料號',
  material_name: '品名',
  quantity: '數量',
  adjustment_type: '異動類型',
  action: '處置方式',
  reason: '原因',
  note: '說明',
};
const SOURCE_PREVIEW_LIMIT = 3;

function describePayload(payload) {
  return Object.entries(payload)
    .map(([field, value]) =>
      field === 'items'
        ? `品項：\n${value.map((item, index) => `${index + 1}. ${describePayload(item)}`).join('\n')}`
        : `${PAYLOAD_LABELS[field] || field}：${String(value)}`,
    )
    .join('\n');
}

function currentIntent() {
  return aiState.activeIntent || 'auto';
}

function currentIntentConfig(intent = currentIntent()) {
  return INTENT_CONFIG[intent] || INTENT_CONFIG.query;
}

function isWriteIntent(intent = currentIntent()) {
  return WRITE_INTENTS.has(intent);
}

function cleanedReferenceLabel(intent = currentIntent()) {
  return currentIntentConfig(intent).referenceLabel.replace(/（[^）]+）/g, '');
}

// Exploration wording wins over topic keywords, so asking about a topic is not treated as writing.
function inferIntentFromMessage(message) {
  const source = normalizeBaseText(message);
  const active = currentIntent();

  if (/查詢|查一下|有哪些|有什麼|哪幾|多少|幾筆|列出|清單|說明|狀態|KPI|報表|統計|\?|？/.test(source)) return 'query';
  if (/建立採購|新增採購|新採購|開一張採購|開採購/.test(source)) return 'create_purchase_order';
  if (/收料|驗收|實收/.test(source)) return 'receive';
  if (/盤點調整|庫存調整|退貨|報廢/.test(source)) return 'adjust_inventory';
  if (/異常處置|差異允收|補貨/.test(source)) return 'resolve_exception';

  if (isWriteIntent(active)) return active;
  return 'query';
}

// One shared context for the whole conversation; the intent only decides which id is quoted back.
function rememberedContext() {
  return aiState.contextMemory;
}

function rememberedReference(intent = currentIntent()) {
  const { po_id: poId = '', material_id: materialId = '' } = rememberedContext();
  const { referenceType } = currentIntentConfig(intent);
  if (referenceType === 'po') return poId;
  if (referenceType === 'material') return materialId;
  return poId || materialId;
}

function rememberContextFields(fields) {
  const meaningful = Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
  if (!Object.keys(meaningful).length) return;
  aiState.contextMemory = { ...rememberedContext(), ...meaningful };
}

function previewLines(items, formatter) {
  const visible = items.slice(0, SOURCE_PREVIEW_LIMIT).map(formatter).filter(Boolean);
  if (!visible.length) return '無資料';
  const more = items.length > SOURCE_PREVIEW_LIMIT ? `\n…其餘 ${items.length - SOURCE_PREVIEW_LIMIT} 筆略` : '';
  return `${visible.join('\n')}${more}`;
}

function summarizeToolSource(source) {
  const data = source.data || {};
  switch (source.tool) {
    case 'get_dashboard':
      return [
        'KPI 摘要',
        `採購單總數：${data.total_purchase_orders ?? '—'}`,
        `待驗收 / 待補貨：${data.pending_receipts ?? '—'}`,
        `已完成收料：${data.completed_receipts ?? '—'}`,
        `低庫存料號：${data.low_stock_count ?? '—'}`,
      ].join('\n');
    case 'list_purchase_orders':
      return `採購單 ${data.items?.length || 0} 筆${data.next_cursor ? '（尚有下一頁）' : ''}\n${previewLines(data.items || [], item => `${item.po_id}｜${item.supplier_name}｜${item.status}`)}`;
    case 'list_inventory':
      return `庫存 ${data.items?.length || 0} 筆${data.next_cursor ? '（尚有下一頁）' : ''}\n${previewLines(data.items || [], item => `${item.material_id}｜${item.material_name}｜可用 ${item.quantity}`)}`;
    case 'list_inventory_transactions':
      return `庫存異動 ${data.items?.length || 0} 筆${data.next_cursor ? '（尚有下一頁）' : ''}\n${previewLines(data.items || [], item => `${item.reference_id}｜${item.material_id}｜${item.transaction_type} ${item.quantity_change}`)}`;
    default:
      return JSON.stringify(source, null, 2);
  }
}

function summarizeDraftResult(action, data) {
  switch (action) {
    case 'create_purchase_order':
      return `已建立採購單 ${data.po_id}，供應商 ${data.supplier_name}，狀態 ${data.status}。`;
    case 'receive': {
      const exceptions = Array.isArray(data.exceptions) && data.exceptions.length
        ? `\n異常：${data.exceptions.join('、')}`
        : '';
      return `已送出收料 ${data.receipt_id}，採購單 ${data.po_id}，狀態 ${data.status}。${exceptions}`;
    }
    case 'adjust_inventory':
      return `已完成${data.adjustment_type}，料號 ${data.material_id}，庫存 ${data.quantity_before} → ${data.quantity_after}。`;
    case 'resolve_exception':
      return `已更新採購單 ${data.po_id}，處置方式 ${data.exception_action}，目前狀態 ${data.status}。`;
    default:
      return JSON.stringify(data, null, 2);
  }
}

function summarizeActionRecord(action) {
  const history = action.events.map(event => `${jobStatusLabel(event.status)} ${formatDateTime(event.at)}`).join('\n');
  const result = action.result
    ? summarizeDraftResult(action.preview.action, action.result)
    : action.error || '尚無結果';
  return [
    '草稿內容：',
    describePayload(action.preview.payload),
    '',
    '歷程：',
    history,
    '',
    `結果：${result}`,
  ].join('\n');
}

export function resetAiChat() {
  aiState.history = [];
  aiState.activeIntent = 'auto';
  aiState.contextMemory = {};
  aiState.pendingDraftIds.clear();
  session.generation += 1;
  $('aiLog').replaceChildren();
  $('aiActions').replaceChildren();
  $('aiStatus').textContent = '';
  // Also runs on sign-out, so the next user must not inherit a typed question.
  $('aiMessage').value = '';
  $('aiVoiceStatus').textContent = '勾選後，語音結束會自動送出。';
  applyAiIntentUi();
  updateDraftLock();
}

function setVoiceUi(listening, message) {
  voiceState.listening = listening;
  $('aiVoice').classList.toggle('listening', listening);
  $('aiVoice').textContent = listening ? '停止語音輸入' : '語音輸入';
  if (message) $('aiVoiceStatus').textContent = message;
}

function startErrorMessage(error) {
  if (!error) return '語音輸入啟動失敗，請稍後重試。';
  if (error.name === 'InvalidStateError') {
    return '語音辨識尚未完全停止，請稍候再試。';
  }
  if (error.name === 'NotAllowedError') {
    return VOICE_ERRORS['not-allowed'];
  }
  return '語音輸入啟動失敗，請稍後重試。';
}

function clearVoiceAutoStopTimer() {
  if (voiceState.autoStopTimer) {
    clearTimeout(voiceState.autoStopTimer);
    voiceState.autoStopTimer = null;
  }
}

function scheduleVoiceAutoStop() {
  clearVoiceAutoStopTimer();
  voiceState.autoStopTimer = setTimeout(() => {
    if (!voiceState.listening || !voiceState.recognition) return;
    voiceState.recognition.stop();
  }, VOICE_IDLE_STOP_MS);
}

function submitAiMessage() {
  $('aiForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

// Typed text keeps its identifiers verbatim; only speech gets the lossy spoken-form rewriting.
function normalizeTypedText(text) {
  let value = (text || '').normalize('NFKC').trim();
  for (const [from, to] of SIMPLE_TO_TRADITIONAL) {
    value = value.replaceAll(from, to);
  }
  return value;
}

function normalizeBaseText(text) {
  let value = (text || '').normalize('NFKC').trim();
  for (const [from, to] of SIMPLE_TO_TRADITIONAL) {
    value = value.replaceAll(from, to);
  }
  value = value.replace(/\bp\s*o\b/gi, 'PO');
  value = value.replace(/\bpo\b/gi, 'PO');
  return value.replace(/\s+/g, ' ');
}

function normalizeSpeechTranscript(text) {
  let value = normalizeBaseText(text);
  value = value.replace(/\bPO\s*(?:為|之|第)?\s*([零〇一二兩两三四五六七八九十百千萬万\dA-Z-]+)/gi, (_, raw) => formatPoReference(raw) || `PO ${raw}`);
  value = value.replace(/((?:數量|訂購(?:數量)?)\s*(?:是|為|[:：])?\s*)([零〇一二兩两三四五六七八九十百千萬万\d]+)/gi, (_, prefix, raw) => {
    const parsed = chineseNumberToInt(raw);
    return Number.isFinite(parsed) ? `${prefix}${parsed}` : `${prefix}${raw}`;
  });
  value = value.replace(/([零〇一二兩两三四五六七八九十百千萬万\d]+)\s*(個|件|支|箱|PCS)/gi, (_, raw, unit) => {
    const parsed = chineseNumberToInt(raw);
    return Number.isFinite(parsed) ? `${parsed}${unit}` : `${raw}${unit}`;
  });
  value = value.replace(/([零〇一二兩两三四五六七八九十百千萬万\d]+)月([零〇一二兩两三四五六七八九十百千萬万\d]+)(日|號)/g, (_, month, day, suffix) => {
    const parsedMonth = chineseNumberToInt(month);
    const parsedDay = chineseNumberToInt(day);
    if (Number.isFinite(parsedMonth) && Number.isFinite(parsedDay)) return `${parsedMonth}月${parsedDay}${suffix}`;
    return `${month}月${day}${suffix}`;
  });
  return value.replace(/\s+/g, ' ');
}

function chineseNumberToInt(raw) {
  const text = String(raw || '').trim();
  if (!text) return Number.NaN;
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);

  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of text) {
    if (char in CN_DIGITS) {
      number = CN_DIGITS[char];
      continue;
    }
    if (char in CN_UNITS) {
      section += (number || 1) * CN_UNITS[char];
      number = 0;
      continue;
    }
    if (char === '萬' || char === '万') {
      section = (section + number) * 10000;
      total += section;
      section = 0;
      number = 0;
      continue;
    }
    return Number.NaN;
  }
  return total + section + number;
}

function normalizePoId(text) {
  // Drop explicitly labelled material tokens first, so a material id is never read as a PO.
  const source = normalizeBaseText(text)
    .toUpperCase()
    .replace(/(?:料號|品號)\s*(?:是|為|[:：])?\s*[A-Z0-9-]+/g, ' ');
  const labeled = source.match(/(?:採購單號|單號)\s*(?:是|為|[:：])?\s*(PO[-\s]?[A-Z0-9-]+|[零〇一二兩两三四五六七八九十百千萬万\d][零〇一二兩两三四五六七八九十百千萬万\d-]*)/);
  if (labeled) {
    return formatPoReference(labeled[1]);
  }
  const direct = source.match(/\bPO[-\s]?[A-Z0-9-]{1,}\b/);
  if (direct) return formatPoReference(direct[0]);

  const spoken = source.match(/\bPO\s*(?:為|之|第)?\s*([零〇一二兩两三四五六七八九十百千萬万\dA-Z-]+)/);
  if (!spoken) return '';
  return formatPoReference(spoken[1]);
}

// Never renumber an id the user supplied; only spoken Chinese numerals are converted.
function formatPoReference(raw) {
  const source = normalizeBaseText(raw).toUpperCase();
  const cleaned = source.replace(/^PO/, '').replace(/^[\s:：-]+/, '').replace(/\s+/g, '');
  if (!cleaned) return '';
  if (/^[A-Z0-9][A-Z0-9-]*$/.test(cleaned)) return `PO-${cleaned}`;
  const spokenNumber = chineseNumberToInt(cleaned);
  return Number.isFinite(spokenNumber) ? `PO-${spokenNumber}` : '';
}

function extractMaterialId(text) {
  const source = normalizeBaseText(text).toUpperCase();
  const explicit = source.match(/(?:料號|品號)\s*(?:是|為|[:：])?\s*([A-Z0-9-]+)/);
  if (explicit && !/^PO[-\d]/.test(explicit[1])) return explicit[1];
  const generic = source.match(/\b([A-Z]{2,})-?(\d{2,})\b/);
  if (generic && generic[1] !== 'PO') return `${generic[1]}-${generic[2]}`;
  return '';
}

function extractReferenceFromMessage(message, intent = currentIntent()) {
  const config = currentIntentConfig(intent);
  if (config.referenceType === 'po') return normalizePoId(message);
  if (config.referenceType === 'material') return extractMaterialId(message);
  const poReference = normalizePoId(message);
  if (poReference) return poReference;
  return extractMaterialId(message);
}

function extractSupplierName(text) {
  const source = normalizeBaseText(text);
  const match = source.match(/(?:供應商|廠商|供貨商)\s*(?:是|為|[:：])?\s*([^,，。；\n]+)/);
  return match?.[1]?.trim() || '';
}

function extractDateValue(text) {
  const source = normalizeSpeechTranscript(text);
  const full = source.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})|(\d{4}年\d{1,2}月\d{1,2}(?:日|號)?)/);
  if (full) return (full[1] || full[2]).replace(/號$/, '日');
  const short = source.match(/(\d{1,2}月\d{1,2}(?:日|號))/);
  return short ? short[1].replace(/號$/, '日') : '';
}

function extractMaterialName(text) {
  const source = normalizeBaseText(text);
  const match = source.match(/(?:品名|料件名稱)\s*(?:是|為|[:：])?\s*([^,，。；\n]+)/);
  return match?.[1]?.trim() || '';
}

function extractQuantityValue(text) {
  const source = normalizeSpeechTranscript(text);
  const labeled = source.match(/(?:數量|訂購(?:數量)?|本次收料|異動數量)\s*(?:是|為|[:：])?\s*(-?\d+)/);
  if (labeled) return labeled[1];
  const general = source.match(/(-?\d+)\s*(?:個|件|支|箱|PCS)/i);
  return general?.[1] || '';
}

function extractAdjustmentType(text) {
  const source = normalizeBaseText(text);
  if (source.includes('盤點調整')) return '盤點調整';
  if (source.includes('退貨')) return '退貨';
  if (source.includes('報廢')) return '報廢';
  return '';
}

function extractActionValue(text) {
  const source = normalizeBaseText(text);
  if (source.includes('差異允收結案')) return '差異允收結案';
  if (source.includes('補貨')) return '補貨';
  return '';
}

function extractReasonLike(text, fieldNames = ['原因', '說明', '備註']) {
  const source = normalizeBaseText(text);
  const pattern = new RegExp(`(?:${fieldNames.join('|')})\\s*(?:是|為|[:：])?\\s*([^,，。；\\n]+)`);
  return source.match(pattern)?.[1]?.trim() || '';
}

function extractIntentFields(message, intent = currentIntent()) {
  const reference = extractReferenceFromMessage(message, intent);
  if (intent === 'create_purchase_order') {
    return {
      po_id: reference,
      supplier_name: extractSupplierName(message),
      expected_date: extractDateValue(message),
      material_id: extractMaterialId(message),
      material_name: extractMaterialName(message),
      quantity: extractQuantityValue(message),
    };
  }
  if (intent === 'receive') {
    return {
      po_id: reference,
      material_id: extractMaterialId(message),
      quantity: extractQuantityValue(message),
    };
  }
  if (intent === 'adjust_inventory') {
    return {
      material_id: reference,
      adjustment_type: extractAdjustmentType(message),
      quantity: extractQuantityValue(message),
      reason: extractReasonLike(message, ['原因', '說明']),
    };
  }
  if (intent === 'resolve_exception') {
    return {
      po_id: reference,
      action: extractActionValue(message),
      note: extractReasonLike(message, ['說明', '備註', '原因']),
    };
  }
  return {
    po_id: normalizePoId(message),
    material_id: extractMaterialId(message),
  };
}

function summarizeKnownFields(intent, fields) {
  const keys = INTENT_MEMORY_FIELDS[intent] || [];
  return keys
    .filter(key => fields[key])
    .map(key => `${INTENT_FIELD_LABELS[key] || key}：${fields[key]}`);
}

async function normalizeVoiceText(text) {
  const local = normalizeSpeechTranscript(text);
  try {
    const result = await api('/api/ai/normalize', { method: 'POST', body: { text: local } });
    return normalizeSpeechTranscript((result?.text || local).trim() || local);
  } catch {
    return local;
  }
}

async function normalizeSubmittedText(text) {
  const local = normalizeTypedText(text);
  if (!local) return local;
  try {
    const result = await api('/api/ai/normalize', { method: 'POST', body: { text: local } });
    return normalizeTypedText((result?.text || local).trim() || local);
  } catch {
    return local;
  }
}

function maybeAutoSubmitAfterVoice() {
  if (aiState.pendingDraftIds.size) return;
  if ($('aiVoiceAutoSend').checked && $('aiMessage').value.trim()) submitAiMessage();
}

// A draft from the current turn blocks new questions until it is confirmed or cancelled.
function updateDraftLock() {
  const locked = aiState.pendingDraftIds.size > 0;
  $('aiSend').disabled = locked || aiState.busy;
  $('aiMessage').disabled = locked;
  $('aiVoice').disabled = locked || !SpeechRecognition;
  for (const button of document.querySelectorAll('.ai-suggestion')) button.disabled = locked;
  if (locked) $('aiStatus').textContent = '請先按上方草稿的「確認送出」或「取消」；若想直接放棄，可按「清除對話」。';
}

function releaseDraftLock(draftId) {
  aiState.pendingDraftIds.delete(draftId);
  if (!aiState.pendingDraftIds.size) $('aiStatus').textContent = '';
  updateDraftLock();
}

function syncIntentWithMessage(message) {
  aiState.activeIntent = inferIntentFromMessage(message);
  applyAiIntentUi();
}

function applyAiIntentUi() {
  const config = currentIntentConfig();
  const fallback = browserFallbackMessage();
  $('aiMessage').placeholder = config.messagePlaceholder;
  $('aiVoiceChecklist').textContent = config.helpText;
  $('aiVoiceStatus').textContent = fallback || (isWriteIntent()
    ? '送出後會先彙整成草稿，由人工確認後才會寫入。'
    : '勾選後，語音結束會自動送出。');
}

function buildStructuredMessage(message) {
  const intent = currentIntent();
  const config = currentIntentConfig(intent);
  const explicitFields = extractIntentFields(message, intent);
  rememberContextFields(explicitFields);
  const mergedFields = rememberedContext();
  const reference = rememberedReference(intent);
  const lines = [`需求類型：${config.label}`];
  if (reference) lines.push(`${cleanedReferenceLabel(intent)}：${reference}`);
  const knownFieldLines = summarizeKnownFields(intent, mergedFields);
  if (knownFieldLines.length) {
    lines.push('目前已知資訊：');
    lines.push(...knownFieldLines);
  }
  if (config.requiredReference && !reference) {
    lines.push(`目前尚未指定${cleanedReferenceLabel(intent)}。若使用者是在詢問有哪些待處理項目，請先列出候選，再追問缺漏資訊。`);
  }
  if (!explicitFields.po_id && !explicitFields.material_id && reference && config.requiredReference) {
    lines.push(`沿用上一輪${cleanedReferenceLabel(intent)}：${reference}`);
  }
  lines.push(`使用者本輪補充：${message}`);
  return lines.join('\n');
}

function startVoice(recognition) {
  if (voiceState.pendingStart) {
    setVoiceUi(false, '語音辨識啟動中，請稍候。');
    return;
  }
  if (voiceState.listening) {
    voiceState.manualStopRequested = true;
    clearVoiceAutoStopTimer();
    setVoiceUi(false, '語音輸入停止中…');
    recognition.stop();
    return;
  }
  if (aiState.busy) {
    setVoiceUi(false, 'AI 回答中，請稍後再用語音送出。');
    return;
  }
  voiceState.manualStopRequested = false;
  voiceState.pendingStart = true;
  voiceState.restarts = 0;
  try {
    recognition.start();
  } catch (error) {
    voiceState.pendingStart = false;
    setVoiceUi(false, startErrorMessage(error));
  }
}

function browserFallbackMessage() {
  const userAgent = navigator.userAgent || '';
  if (!SpeechRecognition) {
    if (/Edg\//.test(userAgent)) {
      return 'Edge 目前不支援此頁語音辨識，請改用 Chrome，或先在 Edge 語音輸入後貼到文字框。';
    }
    if (/Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)) {
      return 'Safari 語音辨識相容性有限，請改用 Chrome，或先用系統語音輸入再貼到文字框。';
    }
    return '目前瀏覽器不支援語音輸入，請改用 Chrome，或先用系統語音輸入後貼到文字框。';
  }
  if (/Edg\//.test(userAgent)) {
    return 'Edge 版本可能出現語音辨識中斷；若失敗請改用 Chrome。';
  }
  if (/Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)) {
    return 'Safari 可能僅支援部分語音功能；若辨識不穩定請改用 Chrome。';
  }
  return '';
}

function initVoiceInput() {
  const fallback = browserFallbackMessage();
  if (fallback) {
    $('aiVoiceStatus').textContent = fallback;
  }

  if (!SpeechRecognition) {
    $('aiVoice').disabled = true;
    $('aiVoiceAutoSend').disabled = true;
    if (!fallback) $('aiVoiceStatus').textContent = '目前瀏覽器不支援語音輸入，請改用文字。';
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = 'zh-TW';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  voiceState.recognition = recognition;

  recognition.addEventListener('start', () => {
    voiceState.pendingStart = false;
    voiceState.manualStopRequested = false;
    voiceState.lastPartialAt = Date.now();
    setVoiceUi(true, '正在聆聽，請直接說出需求。');
    scheduleVoiceAutoStop();
  });

  recognition.addEventListener('result', async event => {
    let text = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      text += event.results[index][0]?.transcript || '';
    }
    voiceState.lastPartialAt = Date.now();
    voiceState.restarts = 0;
    scheduleVoiceAutoStop();
    if (!text.trim()) return;
    $('aiMessage').value = normalizeSpeechTranscript(text.trim());
    const finalResult = event.results[event.results.length - 1]?.isFinal;
    if (finalResult) {
      $('aiMessage').value = await normalizeVoiceText($('aiMessage').value);
      syncIntentWithMessage($('aiMessage').value);
      if (isWriteIntent()) {
        setVoiceUi(false, '語音辨識完成，已填入內容。送出後會先彙整成草稿，由人工確認後才會寫入。');
      } else {
        setVoiceUi(false, '語音辨識完成，已填入內容。');
      }
      maybeAutoSubmitAfterVoice();
    } else {
      setVoiceUi(true, '辨識中…已即時填入內容。');
    }
  });

  recognition.addEventListener('end', async () => {
    clearVoiceAutoStopTimer();
    voiceState.pendingStart = false;
    if (voiceState.manualStopRequested) {
      voiceState.manualStopRequested = false;
      setVoiceUi(false, '語音輸入已停止。');
      return;
    }
    if (voiceState.listening) {
      const idleMs = Date.now() - voiceState.lastPartialAt;
      if (idleMs < VOICE_IDLE_STOP_MS && voiceState.restarts < VOICE_MAX_RESTARTS && voiceState.recognition) {
        try {
          voiceState.pendingStart = true;
          voiceState.restarts += 1;
          voiceState.recognition.start();
          return;
        } catch {
          voiceState.pendingStart = false;
          // Fall through and finalize when immediate restart is not possible.
        }
      }
      $('aiMessage').value = await normalizeVoiceText($('aiMessage').value);
      syncIntentWithMessage($('aiMessage').value);
      if (isWriteIntent()) {
        setVoiceUi(false, '語音輸入已結束，內容已填入。送出後會先彙整成草稿，由人工確認後才會寫入。');
      } else {
        setVoiceUi(false, '語音輸入已結束，內容已填入。');
      }
      maybeAutoSubmitAfterVoice();
    }
  });

  recognition.addEventListener('error', event => {
    clearVoiceAutoStopTimer();
    voiceState.pendingStart = false;
    voiceState.manualStopRequested = false;
    setVoiceUi(false, VOICE_ERRORS[event.error] || '語音辨識失敗，請再試一次。');
  });

  $('aiVoice').addEventListener('click', () => startVoice(recognition));
}

function appendMessage(role, body) {
  const entry = el('div', {
    className: `chat-message ${role}`,
    textContent: `${role === 'user' ? '你' : 'AI 助理'}：\n${body}`,
  });
  $('aiLog').append(entry);
  entry.scrollIntoView({ block: 'nearest' });
  return entry;
}

function showDraft(entry, draft, generation, { lock = false } = {}) {
  const title = el('strong', { textContent: `${draft.title} · 待確認` });
  const content = el('pre', { textContent: describePayload(draft.payload) });
  const confirm = el('button', { type: 'button', className: 'button primary', textContent: '確認送出' });
  const cancel = el('button', { type: 'button', className: 'button', textContent: '取消' });
  const result = el('p', {});

  if (lock) {
    aiState.pendingDraftIds.add(draft.id);
    updateDraftLock();
  }

  cancel.addEventListener('click', async () => {
    if (generation !== session.generation) return;
    confirm.disabled = true;
    cancel.disabled = true;
    try {
      await api(`/api/ai/actions/${encodeURIComponent(draft.id)}/cancel`, { method: 'POST' });
      if (generation !== session.generation) return;
      title.textContent = `${draft.title} · 已取消`;
      result.textContent = '已取消，未送出。';
    } catch (error) {
      result.textContent = `${authErrorMessage(error)}\n此草稿已不再阻擋提問，請到「我的 AI 操作紀錄」查看最新狀態。`;
    } finally {
      // Choosing cancel must always free the chat, otherwise a server refusal strands the user.
      if (generation === session.generation) releaseDraftLock(draft.id);
      loadAiActions().catch(() => {});
    }
  });

  confirm.addEventListener('click', async () => {
    if (generation !== session.generation) return;
    if (!CONFIRMABLE_PATHS.includes(draft.path) && !RESOLUTION_PATH.test(draft.path)) {
      result.textContent = '此草稿的操作類型不支援直接送出，請按「取消」後重新描述需求。';
      return;
    }
    confirm.disabled = true;
    cancel.disabled = true;
    result.textContent = '正在送出…';
    try {
      const data = await api(`/api/ai/actions/${encodeURIComponent(draft.id)}/confirm`, { method: 'POST' });
      if (generation !== session.generation) return;
      title.textContent = `${draft.title} · 已完成`;
      result.textContent = summarizeDraftResult(draft.action, data);
      releaseDraftLock(draft.id);
      // The write already succeeded, so a failing dashboard refresh must not look like a failure.
      refresh().catch(() => {});
      loadAiActions().catch(() => {});
    } catch (error) {
      if (generation !== session.generation) return;
      result.textContent = authErrorMessage(error);
      // Reuse the same action id so a retry stays idempotent.
      confirm.disabled = false;
      cancel.disabled = false;
      confirm.textContent = '重新送出';
    }
  });

  entry.append(el('div', { className: 'chat-draft' }, title, content, confirm, cancel, result));
}

export async function loadAiActions() {
  const generation = session.generation;
  const actions = await api('/api/ai/actions');
  if (generation !== session.generation) return;
  if (!actions.length) {
    $('aiActions').replaceChildren(el('p', { className: 'help', textContent: '尚無 AI 操作紀錄。' }));
    return;
  }
  $('aiActions').replaceChildren(
    ...actions.map(action => {
      const card = el(
        'details',
        {},
        el('summary', {
          textContent: `${action.preview.title} · ${jobStatusLabel(action.status)} · ${formatDateTime(action.created_at)}`,
        }),
        el('pre', {
          textContent: summarizeActionRecord(action),
        }),
      );
      if (OPEN_ACTION_STATUSES.includes(action.status)) {
        showDraft(card, { ...action.preview, id: action.id }, generation);
      }
      return card;
    }),
  );
}

export function onAiPanelShown() {
  if (!tokenValue()) return;
  loadAiActions().catch(error => {
    $('aiActions').replaceChildren(el('p', { className: 'help', textContent: authErrorMessage(error) }));
  });
}

export function initAi() {
  $('aiClear').addEventListener('click', resetAiChat);
  document.addEventListener('erp:signout', resetAiChat);
  initVoiceInput();
  applyAiIntentUi();

  for (const button of document.querySelectorAll('.ai-suggestion')) {
    button.addEventListener('click', () => {
      $('aiMessage').value = button.textContent;
      $('aiMessage').focus();
    });
  }

  $('aiForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (aiState.busy) return;
    if (aiState.pendingDraftIds.size) {
      updateDraftLock();
      return;
    }
    const normalizedMessage = await normalizeSubmittedText($('aiMessage').value);
    $('aiMessage').value = normalizedMessage;
    const message = normalizedMessage.trim();
    if (!message) return;
    syncIntentWithMessage(message);
    const structuredMessage = buildStructuredMessage(message);
    if (!structuredMessage) return;
    const generation = session.generation;
    aiState.busy = true;
    $('aiSend').disabled = true;
    $('aiStatus').textContent = '正在查詢與整理資料…';
    appendMessage('user', message);
    $('aiMessage').value = '';
    try {
      const response = await api('/api/ai/chat', {
        method: 'POST',
        body: { message: structuredMessage, history: aiState.history.slice(-8) },
      });
      if (generation !== session.generation) return;
      const entry = appendMessage('assistant', response.answer);
      if (response.sources.length) {
        entry.append(
          el(
            'details',
            {},
            el('summary', { textContent: '查看本次查詢來源' }),
            el('pre', { textContent: response.sources.map(summarizeToolSource).join('\n\n') }),
          ),
        );
      }
      response.drafts.forEach(draft => showDraft(entry, draft, generation, { lock: true }));
      aiState.history.push(
        { role: 'user', content: structuredMessage },
        { role: 'assistant', content: response.answer.slice(0, 6000) },
      );
      aiState.history = aiState.history.slice(-8);
      $('aiStatus').textContent = response.drafts.length
        ? '已整理草稿，請核對內容後按「確認送出」。'
        : '回答已完成。';
    } catch (error) {
      if (generation === session.generation) {
        appendMessage('assistant', authErrorMessage(error));
        $('aiMessage').value = message;
        $('aiStatus').textContent = '未取得回答，可重新送出。';
      }
    } finally {
      aiState.busy = false;
      updateDraftLock();
    }
  });
}

export const $ = id => document.getElementById(id);

const DIRECT_PROPERTIES = new Set(['className', 'textContent', 'value', 'type', 'disabled', 'hidden', 'colSpan', 'href', 'download', 'placeholder']);

export function el(tag, properties = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(properties)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'dataset') Object.assign(node.dataset, value);
    else if (DIRECT_PROPERTIES.has(name)) node[name] = value;
    else node.setAttribute(name, String(value));
  }
  node.append(...children.filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

export const text = value => document.createTextNode(String(value ?? ''));

export const formatDateTime = value => (value ? new Date(value).toLocaleString('zh-TW') : '—');

export const newKey = prefix =>
  `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;

export function setResult(id, message, type = '') {
  const element = $(id);
  element.hidden = !message;
  element.className = `result ${type}`.trim();
  element.textContent = message || '';
}

export function replaceRows(tableBodyId, rows, columns, emptyMessage) {
  const body = $(tableBodyId);
  body.replaceChildren(
    ...(rows.length
      ? rows
      : [el('tr', {}, el('td', { colSpan: columns, className: 'empty', textContent: emptyMessage }))]),
  );
}

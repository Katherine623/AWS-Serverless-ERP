import pptxgen from "/tmp/erp-slide-deps/node_modules/pptxgenjs/dist/pptxgen.cjs.js";

const pptx = new pptxgen();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "AWS Serverless ERP";
pptx.company = "Portfolio Project";
pptx.subject = "AWS Serverless ERP Receiving and Exception Management";
pptx.title = "AWS Serverless ERP 完整專案簡報";
pptx.lang = "zh-TW";
pptx.theme = { headFontFace: "Noto Sans TC", bodyFontFace: "Noto Sans TC", lang: "zh-TW" };

const c = { ink: "123B3B", muted: "5D7772", canvas: "F3F6F1", panel: "FFFEFA", border: "D9E5DE", teal: "007C70", deep: "07584F", green: "1B8A61", amber: "C97822", red: "C64E45", white: "FFFFFF", paleTeal: "E5F2ED", paleAmber: "FFF0DE", paleRed: "FBE9E6" };

function text(slide, value, options = {}) {
  slide.addText(value, { fontFace: "Noto Sans TC", color: c.ink, margin: 0, fit: "shrink", breakLine: false, ...options });
}

function box(slide, x, y, w, h, options = {}) {
  slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.07, fill: { color: c.panel }, line: { color: c.border, width: 0.7 }, ...options });
}

function base(title, subtitle, number) {
  const slide = pptx.addSlide();
  slide.background = { color: c.canvas };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.08, fill: { color: c.teal }, line: { color: c.teal } });
  text(slide, "AWS SERVERLESS ERP", { x: 0.63, y: 0.3, w: 2.3, h: 0.15, fontSize: 7.5, bold: true, charSpacing: 1.2, color: c.teal });
  text(slide, title, { x: 0.62, y: 0.58, w: 9.7, h: 0.4, fontSize: 23, bold: true });
  text(slide, subtitle, { x: 0.64, y: 1.05, w: 9.8, h: 0.22, fontSize: 10, color: c.muted });
  text(slide, String(number).padStart(2, "0"), { x: 12.05, y: 0.42, w: 0.62, h: 0.2, fontSize: 9, bold: true, align: "right", color: c.muted });
  return slide;
}

function footer(slide, value = "Portfolio Project · FastAPI · AWS Lambda · DynamoDB · Terraform") {
  slide.addShape(pptx.ShapeType.line, { x: 0.62, y: 7.03, w: 12.05, h: 0, line: { color: c.border, width: 0.7 } });
  text(slide, value, { x: 0.63, y: 7.17, w: 10, h: 0.14, fontSize: 7.2, color: c.muted });
}

function pill(slide, value, x, y, w, fill, color = c.ink) {
  slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 0.3, rectRadius: 0.12, fill: { color: fill }, line: { color: fill } });
  text(slide, value, { x, y: y + 0.08, w, h: 0.11, fontSize: 7.2, bold: true, align: "center", color });
}

function bulletList(slide, items, x, y, w, color = c.teal) {
  items.forEach((item, index) => {
    const itemY = y + index * 0.48;
    slide.addShape(pptx.ShapeType.ellipse, { x, y: itemY + 0.06, w: 0.11, h: 0.11, fill: { color }, line: { color } });
    text(slide, item, { x: x + 0.23, y: itemY, w: w - 0.23, h: 0.22, fontSize: 10, color: c.ink });
  });
}

// 1. Cover
{
  const slide = pptx.addSlide();
  slide.background = { color: c.canvas };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.1, fill: { color: c.teal }, line: { color: c.teal } });
  slide.addShape(pptx.ShapeType.arc, { x: 8.4, y: 0.65, w: 4.1, h: 4.1, adjustPoint: 0.25, line: { color: "B9DED0", width: 18, transparency: 25 }, fill: { color: c.canvas, transparency: 100 } });
  text(slide, "AWS SERVERLESS ERP", { x: 0.75, y: 1.08, w: 3.3, h: 0.2, fontSize: 10, bold: true, charSpacing: 1.8, color: c.teal });
  text(slide, "採購、收料與\n異常處置平台", { x: 0.73, y: 1.55, w: 7.5, h: 1.35, fontSize: 34, bold: true, breakLine: true });
  text(slide, "用 AWS Serverless 打造可追溯的 PO 驗收、部分收料、補貨與庫存帳本流程", { x: 0.78, y: 3.08, w: 6.65, h: 0.42, fontSize: 14, color: c.muted });
  pill(slide, "Portfolio / Demo System", 0.78, 4.03, 1.82, c.paleTeal, c.green);
  pill(slide, "ap-northeast-1", 2.75, 4.03, 1.42, c.paleAmber, c.amber);
  box(slide, 8.38, 1.55, 3.8, 3.85, { fill: { color: c.panel }, line: { color: "B9DED0", width: 1 } });
  text(slide, "核心成果", { x: 8.78, y: 1.95, w: 1.6, h: 0.23, fontSize: 15, bold: true });
  bulletList(slide, ["部分收料與剩餘待收量", "補貨 / 差異允收結案", "DynamoDB 原子交易", "Alert outbox worker + SNS 警示"], 8.78, 2.48, 2.98);
  text(slide, "專案簡報 · 2026", { x: 0.78, y: 6.7, w: 2.2, h: 0.18, fontSize: 9, color: c.muted });
}

// 2. Problem
{
  const slide = base("問題：收料不是把數字加到庫存而已", "採購現場需要處理少到貨、補貨、差異核准與可追溯性。", 2);
  [
    ["短缺", "採購 100，實收 80；20 件要如何追蹤？", c.amber],
    ["重複入帳", "網路重試或雙人操作，不能讓庫存加兩次。", c.red],
    ["資料不一致", "同料號不同品名會造成庫存與帳本對不起來。", c.red],
    ["無法稽核", "必須知道誰處置、何時核准、差異是多少。", c.teal],
  ].forEach(([title, detail, accent], index) => {
    const x = 0.65 + (index % 2) * 6.05;
    const y = 1.72 + Math.floor(index / 2) * 2.15;
    box(slide, x, y, 5.55, 1.65);
    slide.addShape(pptx.ShapeType.rect, { x, y, w: 0.1, h: 1.65, fill: { color: accent }, line: { color: accent } });
    text(slide, title, { x: x + 0.35, y: y + 0.35, w: 1.7, h: 0.25, fontSize: 17, bold: true });
    text(slide, detail, { x: x + 0.35, y: y + 0.82, w: 4.65, h: 0.35, fontSize: 11, color: c.muted });
  });
  text(slide, "本專案的設計原則：讓每個數量變化，都有業務狀態、資料交易與稽核紀錄。", { x: 0.67, y: 6.18, w: 11.2, h: 0.28, fontSize: 15, bold: true, color: c.deep });
  footer(slide);
}

// 3. Goals
{
  const slide = base("專案目標與範圍", "聚焦採購收料模組，而不是嘗試一次重做整套 ERP。", 3);
  const columns = [
    ["業務目標", ["建立可驗收的採購單", "處理全數與部分收料", "將異常帶入可處置流程"], c.teal],
    ["技術目標", ["Serverless、低維運成本", "一致性交易與安全重試", "UI 可直接做面試 Demo"], c.green],
    ["目前不在範圍", ["財務付款與總帳", "完整品質檢驗模組", "WAF / custom domain 等環境整合"], c.amber],
  ];
  columns.forEach(([title, items, accent], index) => {
    const x = 0.66 + index * 4.15;
    box(slide, x, 1.75, 3.76, 3.95);
    slide.addShape(pptx.ShapeType.rect, { x, y: 1.75, w: 3.76, h: 0.12, fill: { color: accent }, line: { color: accent } });
    text(slide, title, { x: x + 0.3, y: 2.18, w: 2.9, h: 0.28, fontSize: 17, bold: true });
    bulletList(slide, items, x + 0.31, 2.85, 3.05, accent);
  });
  footer(slide);
}

// 4. Workflow
{
  const slide = base("ERP 收料主流程", "系統依 PO 狀態控制每一步可以執行的動作。", 4);
  const steps = [["建立 PO", c.teal], ["待驗收", c.teal], ["收料", c.green], ["待處理異常", c.amber], ["補貨 / 差異結案", c.amber], ["已完成", c.green]];
  steps.forEach(([label, accent], index) => {
    const x = 0.67 + index * 2.05;
    slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.05, w: 1.62, h: 0.72, rectRadius: 0.06, fill: { color: index === 3 ? c.paleAmber : c.panel }, line: { color: accent, width: 1.2 } });
    text(slide, label, { x: x + 0.12, y: 2.31, w: 1.38, h: 0.18, fontSize: 10, bold: true, align: "center", color: accent });
    if (index < steps.length - 1) slide.addShape(pptx.ShapeType.chevron, { x: x + 1.75, y: 2.29, w: 0.2, h: 0.2, fill: { color: c.border }, line: { color: c.border } });
  });
  box(slide, 0.67, 3.35, 5.85, 2.25);
  text(slide, "全數收料", { x: 0.98, y: 3.68, w: 1.4, h: 0.23, fontSize: 15, bold: true, color: c.green });
  text(slide, "實收數量 = 訂購數量", { x: 0.98, y: 4.12, w: 2.8, h: 0.2, fontSize: 11, color: c.muted });
  text(slide, "PO 轉為「已完成」；庫存增加；寫入 Receipt 與 Inventory Ledger。", { x: 0.98, y: 4.62, w: 4.8, h: 0.38, fontSize: 10.5 });
  box(slide, 6.79, 3.35, 5.85, 2.25);
  text(slide, "部分收料", { x: 7.1, y: 3.68, w: 1.6, h: 0.23, fontSize: 15, bold: true, color: c.amber });
  text(slide, "實收數量 < 訂購數量", { x: 7.1, y: 4.12, w: 2.8, h: 0.2, fontSize: 11, color: c.muted });
  text(slide, "PO 轉為「待處理異常」；採購選擇補貨或差異允收結案。", { x: 7.1, y: 4.62, w: 4.8, h: 0.38, fontSize: 10.5 });
  footer(slide);
}

// 5. Exception workflow
{
  const slide = base("異常處置：把短缺帶回可結案流程", "異常不是終態；必須有責任人、處置理由與下一步。", 5);
  box(slide, 0.67, 1.7, 2.36, 3.9, { fill: { color: c.paleAmber }, line: { color: "E7C598", width: 1 } });
  text(slide, "短缺收料", { x: 0.98, y: 2.1, w: 1.6, h: 0.26, fontSize: 16, bold: true, color: c.amber });
  text(slide, "PO: 100 pcs\n實收: 80 pcs\n剩餘: 20 pcs", { x: 0.98, y: 2.65, w: 1.7, h: 0.85, fontSize: 13, breakLine: true });
  pill(slide, "待處理異常", 0.98, 4.45, 1.4, "F8D9AE", c.amber);
  slide.addShape(pptx.ShapeType.chevron, { x: 3.28, y: 3.3, w: 0.48, h: 0.48, fill: { color: c.border }, line: { color: c.border } });
  [["補貨", "採購確認供應商補足\nPO -> 待補貨\n僅可收剩餘 20 pcs", c.teal], ["差異允收結案", "主管核准短缺\nPO -> 差異結案\n保存 variance 與理由", c.green]].forEach(([title, detail, accent], index) => {
    const x = 4.12 + index * 4.2;
    box(slide, x, 1.7, 3.75, 3.9);
    slide.addShape(pptx.ShapeType.rect, { x, y: 1.7, w: 3.75, h: 0.12, fill: { color: accent }, line: { color: accent } });
    text(slide, title, { x: x + 0.32, y: 2.16, w: 2.7, h: 0.26, fontSize: 16, bold: true, color: accent });
    text(slide, detail, { x: x + 0.32, y: 2.85, w: 2.95, h: 0.9, fontSize: 12, breakLine: true, color: c.muted });
    text(slide, "稽核保存", { x: x + 0.32, y: 4.38, w: 1.2, h: 0.16, fontSize: 8.5, bold: true, color: c.teal });
    text(slide, "action · resolved_by · note · resolved_at · approved_variances", { x: x + 0.32, y: 4.72, w: 2.95, h: 0.35, fontSize: 8.2, color: c.muted });
  });
  footer(slide);
}

// 6. UI demo
{
  const slide = base("Demo 操作介面", "單一操作台同時呈現採購單、庫存、異常處置與可追溯帳本。", 6);
  box(slide, 0.67, 1.6, 7.2, 4.95, { fill: { color: "F8FAF7" } });
  text(slide, "採購控制台", { x: 0.97, y: 1.9, w: 2.2, h: 0.3, fontSize: 18, bold: true });
  [["採購單總數", "6"], ["待驗收", "1"], ["已完成收料", "3"], ["歷史異常", "2"]].forEach(([label, value], index) => {
    const x = 0.97 + index * 1.66;
    slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.42, w: 1.43, h: 0.75, rectRadius: 0.05, fill: { color: c.panel }, line: { color: c.border, width: 0.5 } });
    text(slide, label, { x: x + 0.1, y: 2.58, w: 1.22, h: 0.13, fontSize: 6.5, color: c.muted, align: "center" });
    text(slide, value, { x: x + 0.1, y: 2.8, w: 1.22, h: 0.22, fontSize: 16, bold: true, align: "center", color: index === 3 ? c.red : c.ink });
  });
  text(slide, "採購單", { x: 0.97, y: 3.55, w: 1, h: 0.2, fontSize: 11, bold: true });
  ["PO-2026-002     東亞電子材料     已完成", "DEMO-...         Demo 供應商      待處理異常"].forEach((row, index) => text(slide, row, { x: 0.98, y: 3.96 + index * 0.39, w: 5.8, h: 0.15, fontSize: 8.5, color: index ? c.amber : c.ink }));
  text(slide, "最近庫存異動", { x: 0.97, y: 4.9, w: 1.4, h: 0.2, fontSize: 11, bold: true });
  text(slide, "DEMO-MAT-...  收料 · PO-...                           +80", { x: 0.98, y: 5.3, w: 5.95, h: 0.16, fontSize: 8.3, color: c.muted });
  [["建立 Demo 採購單", "供應商 / 料號 / 品名 / 數量"], ["異常處置", "補貨 / 差異允收結案 / 說明"], ["到貨驗收", "本次收料量 = 剩餘待收量"]].forEach(([title, detail], index) => {
    const y = 1.62 + index * 1.58;
    box(slide, 8.2, y, 4.42, 1.28);
    text(slide, title, { x: 8.5, y: y + 0.25, w: 2.6, h: 0.18, fontSize: 11, bold: true });
    text(slide, detail, { x: 8.5, y: y + 0.61, w: 3.5, h: 0.15, fontSize: 8.5, color: c.muted });
  });
  footer(slide);
}

// 7. Architecture
{
  const slide = base("AWS 架構與資料流", "以 API Gateway + Lambda + DynamoDB + SNS 組合，作業台直接整合篩選、調整與 XLSX import。", 7);
  const nodes = [["Web UI", "Browser Dashboard", 0.72, c.deep], ["API Gateway", "HTTP API", 3.0, c.teal], ["API Lambda", "FastAPI / Mangum", 5.28, c.green], ["DynamoDB", "PO · Receipt · Inventory\nLedger · Outbox", 7.56, c.teal], ["Alert worker", "EventBridge replay", 10.3, c.amber]];
  nodes.forEach(([title, detail, x, accent], index) => {
    box(slide, x, 2.05, index === 3 ? 2.23 : 1.75, 1.28, { line: { color: accent, width: 1.1 } });
    text(slide, title, { x: x + 0.14, y: 2.37, w: index === 3 ? 1.94 : 1.47, h: 0.18, fontSize: 11, bold: true, align: "center", color: accent });
    text(slide, detail, { x: x + 0.14, y: 2.73, w: index === 3 ? 1.94 : 1.47, h: 0.3, fontSize: 7.5, align: "center", color: c.muted, breakLine: true });
    if (index < nodes.length - 1) slide.addShape(pptx.ShapeType.chevron, { x: x + (index === 3 ? 2.36 : 1.88), y: 2.56, w: 0.28, h: 0.22, fill: { color: c.border }, line: { color: c.border } });
  });
  text(slide, "Alert worker → SNS", { x: 10.35, y: 3.62, w: 1.7, h: 0.18, fontSize: 8.5, bold: true, color: c.amber, align: "center" });
  [["交易一致性", "TransactWriteItems 同步寫入 Receipt、PO、Inventory、Inventory Transaction、Idempotency 與 alert outbox。"], ["成本策略", "DynamoDB PAY_PER_REQUEST、TTL、Lambda 512 MB、CloudWatch retention 可設定；Demo 完成可 destroy。"], ["目前限制", "Cognito 使用者佈建、custom domain、WAF 與正式通知訂閱仍需依環境設定；程式端 role guard 已完成。"]].forEach(([title, detail], index) => {
    const y = 4.08 + index * 0.78;
    text(slide, title, { x: 1.08, y, w: 1.35, h: 0.17, fontSize: 10, bold: true, color: index === 2 ? c.red : c.teal });
    text(slide, detail, { x: 2.58, y, w: 9.5, h: 0.24, fontSize: 9.3, color: c.muted });
  });
  footer(slide);
}

// 8. Data integrity
{
  const slide = base("資料模型與一致性控制", "不是只更新 quantity；每次行為都必須可查、可重試、不可重複入帳。", 8);
  [["Purchase Order", "PO 狀態、訂購量、累積 received_quantity、處置稽核資料", c.teal], ["Receipt", "每次實收的不可變收料紀錄與異常說明", c.green], ["Inventory", "可用量、隔離量、material_id 聚合餘額與安全庫存", c.deep], ["Inventory Transaction", "每筆 + / - 異動、來源文件、執行人、時間", c.amber], ["Idempotency", "相同 key + payload 回傳舊結果；不同 payload 回 409", c.red]].forEach(([title, detail, accent], index) => {
    const x = 0.68 + (index % 3) * 4.18;
    const y = 1.72 + Math.floor(index / 3) * 2.1;
    box(slide, x, y, 3.78, 1.55);
    slide.addShape(pptx.ShapeType.rect, { x, y, w: 0.08, h: 1.55, fill: { color: accent }, line: { color: accent } });
    text(slide, title, { x: x + 0.29, y: y + 0.31, w: 3.0, h: 0.2, fontSize: 12, bold: true, color: accent });
    text(slide, detail, { x: x + 0.29, y: y + 0.76, w: 3.08, h: 0.36, fontSize: 8.8, color: c.muted });
  });
  box(slide, 0.68, 5.06, 12.0, 0.88, { fill: { color: c.paleTeal }, line: { color: "B9DED0", width: 0.8 } });
  text(slide, "關鍵規則", { x: 0.98, y: 5.36, w: 1.1, h: 0.15, fontSize: 9, bold: true, color: c.teal });
  text(slide, "同料號不可使用不同品名 / 單位 · 單張收料不可全為 0 · 超收轉異常待核准 · 每張 PO 最多 48 項以符合 DynamoDB 交易上限", { x: 2.15, y: 5.35, w: 9.9, h: 0.18, fontSize: 8.8, color: c.ink });
  footer(slide);
}

// 9. Demo script
{
  const slide = base("現場 Demo 腳本", "以一張 100 pcs 的 Demo PO，展示正常流程與例外管理。", 9);
  const rows = [["1", "建立 Demo PO", "輸入供應商、料號、品名與 100 pcs", "待驗收"], ["2", "部分收料", "輸入本次收料 80 pcs", "待處理異常"], ["3", "異常處置", "選擇「補貨」，填寫供應商承諾", "待補貨"], ["4", "補收剩餘", "表單自動預填剩餘 20 pcs", "已完成"], ["5", "查看帳本", "最近庫存異動顯示 +80 與 +20", "可稽核"]];
  rows.forEach(([number, action, behavior, result], index) => {
    const y = 1.65 + index * 0.86;
    slide.addShape(pptx.ShapeType.ellipse, { x: 0.9, y: y + 0.06, w: 0.38, h: 0.38, fill: { color: index === 1 ? c.amber : c.teal }, line: { color: index === 1 ? c.amber : c.teal } });
    text(slide, number, { x: 0.99, y: y + 0.17, w: 0.2, h: 0.09, fontSize: 6.5, bold: true, color: c.white, align: "center" });
    text(slide, action, { x: 1.55, y, w: 1.75, h: 0.2, fontSize: 11, bold: true });
    text(slide, behavior, { x: 3.35, y, w: 5.4, h: 0.22, fontSize: 10, color: c.muted });
    pill(slide, result, 9.65, y - 0.02, 1.7, result === "待處理異常" ? c.paleAmber : c.paleTeal, result === "待處理異常" ? c.amber : c.green);
    if (index < rows.length - 1) slide.addShape(pptx.ShapeType.line, { x: 1.09, y: y + 0.46, w: 0, h: 0.38, line: { color: c.border, width: 1.2 } });
  });
  box(slide, 0.9, 6.08, 10.45, 0.48, { fill: { color: "EDF5F1" }, line: { color: "B9DED0", width: 0.6 } });
  text(slide, "可額外示範：重送相同 Idempotency-Key 不會讓庫存再加一次；不同 payload 則回 409。", { x: 1.18, y: 6.24, w: 9.7, h: 0.13, fontSize: 8.8, color: c.deep });
  footer(slide);
}

// 10. Quality and cost
{
  const slide = base("驗證、成本控制與已知風險", "將可靠性說清楚，也誠實標示下一個工程里程碑。", 10);
  box(slide, 0.68, 1.67, 3.75, 4.65);
  text(slide, "已驗證", { x: 0.98, y: 2.04, w: 1.3, h: 0.24, fontSize: 16, bold: true, color: c.green });
  bulletList(slide, ["Domain / config / MCP tests", "Python compile + Ruff", "前端 JavaScript syntax", "CI 執行 pytest + Terraform validate", "部署前保留 runtime 驗證清單"], 0.98, 2.68, 3.0, c.green);
  box(slide, 4.78, 1.67, 3.75, 4.65);
  text(slide, "成本控制", { x: 5.08, y: 2.04, w: 1.5, h: 0.24, fontSize: 16, bold: true, color: c.teal });
  bulletList(slide, ["Lambda ZIP，不使用 ECR", "DynamoDB PAY_PER_REQUEST", "Lambda 512 MB / 30 sec", "CloudWatch retention 可設定", "Demo 結束後可 Terraform destroy"], 5.08, 2.68, 3.0, c.teal);
  box(slide, 8.88, 1.67, 3.75, 4.65, { fill: { color: "FFF9F0" }, line: { color: "E7C598", width: 0.8 } });
  text(slide, "下一步風險處理", { x: 9.18, y: 2.04, w: 2.2, h: 0.24, fontSize: 16, bold: true, color: c.red });
  bulletList(slide, ["正式 Cognito 使用者佈建", "custom domain / WAF / 通知訂閱", "structured logs 與 SBOM", "QC 與 PO / GRN / Invoice 三方匹配"], 9.18, 2.68, 3.0, c.red);
  footer(slide);
}

// 11. Close
{
  const slide = pptx.addSlide();
  slide.background = { color: c.deep };
  slide.addShape(pptx.ShapeType.arc, { x: 8.6, y: -0.8, w: 5.0, h: 5.0, adjustPoint: 0.25, line: { color: "39A88A", width: 20, transparency: 25 }, fill: { color: c.deep, transparency: 100 } });
  text(slide, "AWS SERVERLESS ERP", { x: 0.75, y: 0.92, w: 3.1, h: 0.2, fontSize: 10, bold: true, charSpacing: 1.6, color: "7FE0C4" });
  text(slide, "把 ERP 收料的\n例外流程做成\n可驗證的雲端系統", { x: 0.75, y: 1.42, w: 7.0, h: 1.55, fontSize: 31, bold: true, breakLine: true, color: c.white });
  text(slide, "業務流程 · 資料一致性 · Serverless 架構 · 可展示 UI", { x: 0.78, y: 3.35, w: 6.8, h: 0.25, fontSize: 13, color: "CBE4DA" });
  box(slide, 0.77, 4.25, 6.28, 1.18, { fill: { color: "0B6B61" }, line: { color: "4AAE98", width: 0.8 } });
  text(slide, "Resume-ready project", { x: 1.08, y: 4.57, w: 2.05, h: 0.2, fontSize: 13, bold: true, color: c.white });
  text(slide, "AWS Lambda · API Gateway · DynamoDB · SNS · Terraform · FastAPI", { x: 1.08, y: 4.94, w: 5.4, h: 0.15, fontSize: 8.5, color: "CBE4DA" });
  text(slide, "Thank you", { x: 0.78, y: 6.72, w: 1.5, h: 0.2, fontSize: 11, color: "7FE0C4" });
}

await pptx.writeFile({ fileName: "/home/shaok/aaa/AWS-Serverless-ERP/AWS_Serverless_ERP_Full_Presentation.pptx" });

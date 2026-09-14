import pptxgen from "/tmp/erp-slide-deps/node_modules/pptxgenjs/dist/pptxgen.cjs.js";

const pptx = new pptxgen();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "AWS Serverless ERP";
pptx.company = "Portfolio Project";
pptx.subject = "AWS Serverless ERP Procurement, Receiving and Exception Management";
pptx.title = "AWS Serverless ERP 完整專案簡報";
pptx.lang = "zh-TW";
pptx.theme = { headFontFace: "Noto Sans TC", bodyFontFace: "Noto Sans TC", lang: "zh-TW" };

const c = { ink: "102F35", muted: "607879", canvas: "EEF4F1", panel: "FFFFFF", line: "D7E5DF", teal: "087F73", deep: "07584F", mint: "DFF3EC", green: "1B8A61", amber: "C76F22", amberBg: "FFF1DF", red: "C44743", redBg: "FCE8E5", white: "FFFFFF" };
const W = 13.333;

function addText(slide, value, options = {}) {
  slide.addText(value, { fontFace: "Noto Sans TC", color: c.ink, margin: 0, fit: "shrink", breakLine: false, ...options });
}
function addBox(slide, x, y, w, h, options = {}) {
  slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.06, fill: { color: c.panel }, line: { color: c.line, width: 0.7 }, ...options });
}
function pill(slide, value, x, y, w, fill = c.mint, color = c.teal) {
  slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 0.3, rectRadius: 0.12, fill: { color: fill }, line: { color: fill } });
  addText(slide, value, { x, y: y + 0.08, w, h: 0.12, fontSize: 7.2, bold: true, align: "center", color });
}
function newSlide(title, subtitle, page) {
  const slide = pptx.addSlide();
  slide.background = { color: c.canvas };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.08, fill: { color: c.teal }, line: { color: c.teal } });
  addText(slide, "AWS SERVERLESS ERP", { x: 0.65, y: 0.3, w: 2.4, h: 0.15, fontSize: 7.6, bold: true, charSpacing: 1.2, color: c.teal });
  addText(slide, title, { x: 0.64, y: 0.58, w: 10.6, h: 0.36, fontSize: 23, bold: true });
  addText(slide, subtitle, { x: 0.65, y: 1.05, w: 10.8, h: 0.2, fontSize: 10, color: c.muted });
  addText(slide, String(page).padStart(2, "0"), { x: 12.05, y: 0.4, w: 0.6, h: 0.18, fontSize: 9, bold: true, align: "right", color: c.muted });
  return slide;
}
function footer(slide, message = "Portfolio Project · FastAPI · AWS Lambda · DynamoDB · Terraform") {
  slide.addShape(pptx.ShapeType.line, { x: 0.64, y: 7.04, w: 12.02, h: 0, line: { color: c.line, width: 0.7 } });
  addText(slide, message, { x: 0.65, y: 7.16, w: 9, h: 0.13, fontSize: 7.1, color: c.muted });
}
function bullets(slide, entries, x, y, w, accent = c.teal, size = 10) {
  entries.forEach((entry, index) => {
    const itemY = y + index * 0.47;
    slide.addShape(pptx.ShapeType.ellipse, { x, y: itemY + 0.05, w: 0.11, h: 0.11, fill: { color: accent }, line: { color: accent } });
    addText(slide, entry, { x: x + 0.23, y: itemY, w: w - 0.23, h: 0.22, fontSize: size });
  });
}
function arrow(slide, x, y, w = 0.35) {
  slide.addShape(pptx.ShapeType.chevron, { x, y, w, h: 0.2, fill: { color: c.line }, line: { color: c.line } });
}

// 1 Cover
{
  const slide = pptx.addSlide();
  slide.background = { color: c.canvas };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.1, fill: { color: c.teal }, line: { color: c.teal } });
  slide.addShape(pptx.ShapeType.arc, { x: 8.2, y: 0.18, w: 4.9, h: 4.9, adjustPoint: 0.25, fill: { color: c.canvas, transparency: 100 }, line: { color: "B8DDD0", width: 18, transparency: 20 } });
  addText(slide, "AWS SERVERLESS ERP", { x: 0.78, y: 1.02, w: 3.4, h: 0.22, fontSize: 10, bold: true, charSpacing: 1.8, color: c.teal });
  addText(slide, "採購、收料與\n異常處置平台", { x: 0.76, y: 1.5, w: 7.2, h: 1.22, fontSize: 35, bold: true, breakLine: true });
  addText(slide, "以 AWS Serverless 建立可追溯、可驗證、具 AI 輔助操作邊界的 ERP 收料模組", { x: 0.8, y: 3.05, w: 6.7, h: 0.38, fontSize: 14, color: c.muted });
  pill(slide, "Production-ready design", 0.8, 4.02, 1.92, c.mint, c.green);
  pill(slide, "ap-northeast-1", 2.88, 4.02, 1.45, c.amberBg, c.amber);
  addBox(slide, 8.55, 1.45, 3.75, 3.9, { line: { color: "B8DDD0", width: 1 } });
  addText(slide, "專案亮點", { x: 8.9, y: 1.88, w: 1.8, h: 0.25, fontSize: 16, bold: true });
  bullets(slide, ["PO 驗收與部分收料", "異常處置與隔離庫存", "DynamoDB 原子交易", "Cognito RBAC 與 MCP approval gate", "Outbox 警示重試與 Excel 匯入"], 8.92, 2.45, 2.9, c.teal, 9.2);
  addText(slide, "完整專案簡報 · 2026", { x: 0.8, y: 6.72, w: 2.5, h: 0.18, fontSize: 9, color: c.muted });
}

// 2 Agenda
{
  const slide = newSlide("簡報導覽", "由業務問題出發，依序說明流程、操作、架構、一致性、安全性與後續規劃。", 2);
  const items = ["業務痛點與專案目標", "PO 收料與異常處置流程", "ERP 作業台與 Demo 操作", "AWS 架構、資料流與可用服務", "資料一致性、權限與 AI/MCP 安全邊界", "測試、成本控制與 Roadmap"];
  items.forEach((item, index) => {
    const x = 0.78 + (index % 2) * 6.05; const y = 1.65 + Math.floor(index / 2) * 1.48;
    addBox(slide, x, y, 5.55, 0.98);
    slide.addShape(pptx.ShapeType.ellipse, { x: x + 0.28, y: y + 0.27, w: 0.38, h: 0.38, fill: { color: index < 3 ? c.teal : c.green }, line: { color: index < 3 ? c.teal : c.green } });
    addText(slide, String(index + 1).padStart(2, "0"), { x: x + 0.36, y: y + 0.39, w: 0.21, h: 0.08, fontSize: 6.5, bold: true, color: c.white, align: "center" });
    addText(slide, item, { x: x + 0.92, y: y + 0.32, w: 4.2, h: 0.22, fontSize: 13, bold: true });
  });
  footer(slide);
}

// 3 Problem
{
  const slide = newSlide("為什麼需要這個 ERP 模組？", "收料不是單純將數量加到庫存；它牽涉採購履約、例外處置、庫存可用性與責任歸屬。", 3);
  [["部分到貨", "PO 100 件、實收 80 件；未到的 20 件如何追蹤與結案？", c.amber], ["超收與品質風險", "超過 PO 或未確認品質的貨物，不能直接成為可用庫存。", c.red], ["重試與併發", "網路逾時、重送或多人操作，不能造成重複入帳。", c.red], ["稽核與責任", "異常要留下處置人、理由、時間與核准差異。", c.teal]].forEach(([title, desc, accent], i) => {
    const x = 0.72 + (i % 2) * 6.05; const y = 1.66 + Math.floor(i / 2) * 2.05;
    addBox(slide, x, y, 5.55, 1.55); slide.addShape(pptx.ShapeType.rect, { x, y, w: 0.1, h: 1.55, fill: { color: accent }, line: { color: accent } });
    addText(slide, title, { x: x + 0.35, y: y + 0.31, w: 2, h: 0.25, fontSize: 16, bold: true, color: accent });
    addText(slide, desc, { x: x + 0.35, y: y + 0.82, w: 4.72, h: 0.31, fontSize: 10.5, color: c.muted });
  });
  addText(slide, "設計原則：每一筆庫存變化都要能回答「誰、何時、為何、由哪張文件造成」。", { x: 0.74, y: 6.08, w: 10.7, h: 0.28, fontSize: 15, bold: true, color: c.deep }); footer(slide);
}

// 4 Scope
{
  const slide = newSlide("專案定位與範圍", "以採購收料與例外管理為核心，將範圍收斂成可實際部署與展示的 ERP 子系統。", 4);
  [["已完成的核心", ["採購單建立與料號一致性", "正常 / 部分 / 超收收料", "補貨、差異允收、庫存調整", "帳本、警示、匯入與 UI"], c.teal], ["架構能力", ["API Gateway + Lambda", "DynamoDB transaction + TTL", "Cognito JWT/RBAC", "SNS + EventBridge outbox retry"], c.green], ["下一階段", ["品質檢驗與退貨流程", "GRN / Invoice 三方匹配", "供應商主檔與價格", "正式自訂網域與前端 CDN"], c.amber]].forEach(([title, list, accent], i) => {
    const x = 0.68 + i * 4.18; addBox(slide, x, 1.68, 3.78, 4.35); slide.addShape(pptx.ShapeType.rect, { x, y: 1.68, w: 3.78, h: 0.11, fill: { color: accent }, line: { color: accent } });
    addText(slide, title, { x: x + 0.29, y: 2.1, w: 2.8, h: 0.26, fontSize: 16, bold: true, color: accent }); bullets(slide, list, x + 0.3, 2.78, 3.0, accent, 9.2);
  }); footer(slide);
}

// 5 End-to-end process
{
  const slide = newSlide("端到端 PO 驗收流程", "系統將採購單、收料、可用 / 隔離庫存、異常處置和帳本連成可控閉環。", 5);
  const flow = [["建立 PO", c.teal], ["待驗收", c.teal], ["到貨收料", c.green], ["比對數量", c.green], ["完成 / 異常", c.amber], ["帳本與通知", c.deep]];
  flow.forEach(([label, accent], i) => { const x = 0.67 + i * 2.05; addBox(slide, x, 1.85, 1.63, 0.72, { line: { color: accent, width: 1.1 }, fill: { color: i === 4 ? c.amberBg : c.panel } }); addText(slide, label, { x: x + 0.1, y: 2.12, w: 1.43, h: 0.15, fontSize: 9.5, bold: true, align: "center", color: accent }); if (i < flow.length - 1) arrow(slide, x + 1.73, 2.13); });
  [["全數收料", "實收 = 訂購", "PO -> 已完成\n可用庫存增加\n建立 Receipt + Ledger", c.green], ["部分收料", "實收 < 訂購", "PO -> 待處理異常\n庫存增加已收量\n保留剩餘待收", c.amber], ["超收", "實收 > 訂購", "PO -> 待處理異常\n超收量進隔離庫存\n須核准後才可用", c.red]].forEach(([title, formula, detail, accent], i) => { const x = 0.68 + i * 4.15; addBox(slide, x, 3.48, 3.75, 2.08, { fill: { color: i === 1 ? "FFF9F0" : c.panel } }); addText(slide, title, { x: x + 0.28, y: 3.8, w: 1.5, h: 0.23, fontSize: 15, bold: true, color: accent }); addText(slide, formula, { x: x + 0.28, y: 4.2, w: 2.6, h: 0.17, fontSize: 10, color: c.muted }); addText(slide, detail, { x: x + 0.28, y: 4.65, w: 2.9, h: 0.55, fontSize: 9.2, color: c.ink, breakLine: true }); }); footer(slide);
}

// 6 State machine
{
  const slide = newSlide("PO 狀態機：異常不是終態", "使用受控狀態轉移，防止已結案 PO 被再次收料。", 6);
  const states = [["待驗收", 0.8, 2.15, c.teal], ["待處理異常", 3.2, 2.15, c.amber], ["待補貨", 5.9, 3.9, c.teal], ["差異結案", 9.1, 3.9, c.green], ["已完成", 10.25, 2.15, c.green]];
  states.forEach(([label, x, y, accent]) => { addBox(slide, x, y, 1.8, 0.67, { line: { color: accent, width: 1.1 }, fill: { color: label === "待處理異常" ? c.amberBg : c.panel } }); addText(slide, label, { x: x + 0.1, y: y + 0.25, w: 1.6, h: 0.13, fontSize: 10, bold: true, align: "center", color: accent }); });
  arrow(slide, 2.68, 2.39, 0.32); arrow(slide, 5.25, 2.85, 0.32); arrow(slide, 8.52, 4.15, 0.32); arrow(slide, 9.83, 2.85, 0.32);
  addText(slide, "全數收料", { x: 8.9, y: 1.64, w: 1.1, h: 0.15, fontSize: 8.5, color: c.muted }); addText(slide, "部分收料 / 超收", { x: 3.65, y: 1.64, w: 1.55, h: 0.15, fontSize: 8.5, color: c.muted }); addText(slide, "補貨", { x: 5.98, y: 3.4, w: 0.7, h: 0.15, fontSize: 8.5, color: c.muted }); addText(slide, "差異允收", { x: 7.1, y: 4.18, w: 0.9, h: 0.15, fontSize: 8.5, color: c.muted });
  addBox(slide, 0.82, 5.05, 11.5, 0.72, { fill: { color: c.mint }, line: { color: "B9DED0", width: 0.7 } }); addText(slide, "規則：只有「待驗收」與「待補貨」可收料；「已完成」與「差異結案」不可再次寫入庫存。", { x: 1.1, y: 5.31, w: 10.8, h: 0.16, fontSize: 10, bold: true, color: c.deep }); footer(slide);
}

// 7 Dashboard
{
  const slide = newSlide("ERP 作業台：將日常操作集中在同一個畫面", "UI 以角色、工作佇列、篩選與可追溯性為中心，並非單純展示 KPI。", 7);
  addBox(slide, 0.68, 1.52, 7.55, 5.25, { fill: { color: "F8FAF8" } });
  addText(slide, "採購與庫存作業台", { x: 0.98, y: 1.82, w: 2.8, h: 0.27, fontSize: 17, bold: true }); pill(slide, "warehouse", 6.53, 1.85, 1.08, c.mint, c.teal);
  [["採購單", "6"], ["待驗收", "1"], ["完成收料", "3"], ["異常紀錄", "2"], ["低庫存", "1"], ["隔離量", "20"]].forEach(([label, value], i) => { const x = 0.98 + (i % 3) * 2.15; const y = 2.35 + Math.floor(i / 3) * 0.88; addBox(slide, x, y, 1.85, 0.68); addText(slide, label, { x: x + 0.1, y: y + 0.16, w: 1.1, h: 0.1, fontSize: 6.5, color: c.muted }); addText(slide, value, { x: x + 1.2, y: y + 0.18, w: 0.45, h: 0.18, fontSize: 14, bold: true, align: "right", color: i === 3 ? c.red : c.ink }); });
  addText(slide, "採購單工作佇列", { x: 0.98, y: 4.4, w: 1.7, h: 0.18, fontSize: 11, bold: true }); ["PO-2026-002   東亞電子材料   已完成   200 / 200", "DEMO-...       Demo 供應商    待處理異常   80 / 100"].forEach((row, i) => addText(slide, row, { x: 1.0, y: 4.8 + i * 0.37, w: 6.35, h: 0.13, fontSize: 8.2, color: i ? c.amber : c.ink }));
  addText(slide, "庫存稽核帳本", { x: 0.98, y: 5.72, w: 1.5, h: 0.18, fontSize: 11, bold: true }); addText(slide, "DEMO-MAT-... · 收料 · PO-... · warehouse                                      +80", { x: 1, y: 6.13, w: 6.55, h: 0.13, fontSize: 7.6, color: c.muted });
  [["登入驗證", "Cognito ID Token 與角色提示"], ["建立採購單", "purchaser 角色"], ["到貨驗收", "warehouse 角色 + Idempotency-Key"], ["異常處置", "approver 角色"], ["Excel 匯入", "S3 預簽名 URL + SQS worker"]].forEach(([title, desc], i) => { const y = 1.55 + i * 0.99; addBox(slide, 8.55, y, 3.92, 0.75); addText(slide, title, { x: 8.8, y: y + 0.18, w: 1.55, h: 0.15, fontSize: 10, bold: true, color: c.teal }); addText(slide, desc, { x: 10.4, y: y + 0.19, w: 1.8, h: 0.14, fontSize: 7.6, color: c.muted }); }); footer(slide);
}

// 8 User roles
{
  const slide = newSlide("角色與權限：每個動作都有責任邊界", "Cognito JWT 提供身分與角色，API Gateway 與 FastAPI role guard 雙層確認。", 8);
  [["warehouse", "收料、查看 PO / 庫存 / 帳本", c.teal], ["purchaser", "建立 PO、Excel 匯入、查看營運資料", c.green], ["approver", "差異允收、補貨處置、退貨 / 報廢 / 盤點調整", c.amber], ["admin", "可執行所有 ERP 操作", c.deep]].forEach(([role, permission, accent], i) => { const x = 0.7 + (i % 2) * 6.05; const y = 1.65 + Math.floor(i / 2) * 1.6; addBox(slide, x, y, 5.55, 1.12); pill(slide, role, x + 0.35, y + 0.38, 1.2, i === 2 ? c.amberBg : c.mint, accent); addText(slide, permission, { x: x + 1.85, y: y + 0.43, w: 3.2, h: 0.18, fontSize: 10, color: c.muted }); });
  addBox(slide, 0.7, 5.35, 11.6, 0.65, { fill: { color: c.redBg }, line: { color: "E8BBB7", width: 0.7 } }); addText(slide, "安全原則：前端送來的 received_by / resolved_by 不可信；後端以 JWT subject 覆寫後才寫入稽核紀錄。", { x: 1.0, y: 5.58, w: 10.95, h: 0.15, fontSize: 9.8, bold: true, color: c.red }); footer(slide);
}

// 9 Architecture
{
  const slide = newSlide("核心 AWS Serverless 架構", "以 HTTP API、無伺服器運算、NoSQL 交易與事件通知支援 ERP 操作。", 9);
  const nodes = [["Browser", "ERP 作業台", 0.72, c.deep, 1.6], ["API Gateway", "JWT / throttling", 2.73, c.teal, 1.85], ["Lambda API", "FastAPI + Mangum", 5.04, c.green, 1.8], ["DynamoDB", "主交易資料表", 7.27, c.teal, 1.75], ["SNS", "營運警示", 9.43, c.amber, 1.45], ["CloudWatch", "日誌 / Alarm", 11.26, c.deep, 1.45]];
  nodes.forEach(([name, desc, x, accent, width], i) => { addBox(slide, x, 2.1, width, 1.1, { line: { color: accent, width: 1.1 } }); addText(slide, name, { x: x + 0.08, y: 2.42, w: width - 0.16, h: 0.17, fontSize: 10.2, bold: true, color: accent, align: "center" }); addText(slide, desc, { x: x + 0.08, y: 2.72, w: width - 0.16, h: 0.13, fontSize: 7.2, color: c.muted, align: "center" }); if (i < nodes.length - 1) arrow(slide, x + width + 0.1, 2.55, 0.22); });
  [["同步交易", "Receipt、PO、Inventory、Ledger、Idempotency 與 Alert batch 一次寫入。"], ["可選防護", "DynamoDB PITR、KMS encryption、API access log、CloudWatch alarm、刪除保護。"], ["部署方式", "Terraform 管理基礎設施；Lambda ZIP 避免 ECR 成本與維護負擔。"]].forEach(([title, desc], i) => { const y = 4.14 + i * 0.68; addText(slide, title, { x: 1.0, y, w: 1.35, h: 0.16, fontSize: 10, bold: true, color: c.teal }); addText(slide, desc, { x: 2.48, y, w: 9.7, h: 0.2, fontSize: 9.2, color: c.muted }); }); footer(slide);
}

// 10 Event architecture
{
  const slide = newSlide("可靠通知：Transactional Outbox + EventBridge Retry", "資料先成功入帳；通知失敗不能讓使用者誤以為收料失敗，也不能讓警示遺失。", 10);
  [["收料 API", "DynamoDB Transaction"], ["Alert Batch", "pending 狀態"], ["EventBridge", "每分鐘觸發 worker"], ["Alert Worker", "claim lease / publish"], ["SNS", "Email / downstream"]].forEach(([title, desc], i) => { const x = 0.72 + i * 2.48; addBox(slide, x, 2.05, 1.95, 1.28, { line: { color: i === 1 ? c.amber : c.teal, width: 1 } }); addText(slide, title, { x: x + 0.13, y: 2.41, w: 1.68, h: 0.16, fontSize: 10, bold: true, align: "center", color: i === 1 ? c.amber : c.teal }); addText(slide, desc, { x: x + 0.12, y: 2.72, w: 1.7, h: 0.24, fontSize: 7.4, align: "center", color: c.muted }); if (i < 4) arrow(slide, x + 2.08, 2.56, 0.25); });
  [["寫入成功", "交易回應成功；PO、庫存與帳本一致。", c.green], ["發布成功", "worker 標記 batch published。", c.green], ["發布失敗", "lease 釋放，下一輪 EventBridge 重試。", c.red], ["投遞語意", "at-least-once；下游用 receipt_id + alert_type + material_id 去重。", c.amber]].forEach(([title, desc, accent], i) => { const x = 0.72 + (i % 2) * 6.05; const y = 4.18 + Math.floor(i / 2) * 0.83; addBox(slide, x, y, 5.55, 0.58, { fill: { color: i === 2 ? c.redBg : c.panel } }); addText(slide, title, { x: x + 0.22, y: y + 0.2, w: 1.15, h: 0.13, fontSize: 9, bold: true, color: accent }); addText(slide, desc, { x: x + 1.52, y: y + 0.19, w: 3.7, h: 0.15, fontSize: 8.3, color: c.muted }); }); footer(slide);
}

// 11 Data design
{
  const slide = newSlide("資料模型：庫存餘額與不可變帳本並存", "餘額用於快速作業；交易帳本用於追溯、稽核和問題排查。", 11);
  const entities = [["PurchaseOrder", "PO 狀態、訂購量、已收量、處置資料", c.teal], ["Receipt", "每次實收與收料異常", c.green], ["Inventory", "可用量、隔離量、安全庫存", c.deep], ["InventoryTransaction", "+/- 異動、來源、操作者、時間", c.amber], ["Idempotency", "請求 hash 與 90 天 TTL", c.red], ["AlertBatch", "pending / lease / published 與 30 天 TTL", c.teal]];
  entities.forEach(([name, desc, accent], i) => { const x = 0.7 + (i % 3) * 4.16; const y = 1.62 + Math.floor(i / 3) * 1.85; addBox(slide, x, y, 3.76, 1.3); slide.addShape(pptx.ShapeType.rect, { x, y, w: 0.08, h: 1.3, fill: { color: accent }, line: { color: accent } }); addText(slide, name, { x: x + 0.26, y: y + 0.27, w: 3.0, h: 0.18, fontSize: 11, bold: true, color: accent }); addText(slide, desc, { x: x + 0.26, y: y + 0.72, w: 3.0, h: 0.25, fontSize: 8.8, color: c.muted }); });
  addBox(slide, 0.7, 5.52, 12, 0.55, { fill: { color: c.mint }, line: { color: "B9DED0", width: 0.7 } }); addText(slide, "主鍵模式：單一 DynamoDB 表使用 PK / SK；EntityIndex 支援 entity / entity_key 查詢與 cursor 分頁。", { x: 1.0, y: 5.72, w: 11.2, h: 0.14, fontSize: 9.2, bold: true, color: c.deep }); footer(slide);
}

// 12 Consistency controls
{
  const slide = newSlide("資料一致性與防呆控制", "把 ERP 規則放在 domain 與交易層，而不是只靠 UI 限制。", 12);
  [["Idempotency", "相同 key + 相同 payload 回傳原結果；不同 payload 回 409。"], ["Optimistic locking", "比較原 PO / Inventory 資料；併發異動衝突不會靜默覆寫。"], ["Transaction limit", "PO / receipt 最多 48 項，符合 DynamoDB 100-item transaction 上限。"], ["Master consistency", "同料號不可不同品名或單位；PO 內不得重複料號。"], ["Quantity guard", "禁止全零收料、超過剩餘待收與未授權的庫存異動。"], ["Cursor scope", "opaque cursor 綁定 status / material / supplier filter，避免跨查詢跳頁。"]].forEach(([title, desc], i) => { const x = 0.7 + (i % 2) * 6.05; const y = 1.6 + Math.floor(i / 2) * 1.42; addBox(slide, x, y, 5.55, 1.05); slide.addShape(pptx.ShapeType.ellipse, { x: x + 0.29, y: y + 0.35, w: 0.25, h: 0.25, fill: { color: c.green }, line: { color: c.green } }); addText(slide, title, { x: x + 0.76, y: y + 0.24, w: 2.1, h: 0.17, fontSize: 11, bold: true, color: c.teal }); addText(slide, desc, { x: x + 0.76, y: y + 0.58, w: 4.3, h: 0.2, fontSize: 8.5, color: c.muted }); }); footer(slide);
}

// 13 Security
{
  const slide = newSlide("安全設計：從瀏覽器到資料庫的多層防護", "將身份、授權、輸入驗證、服務權限和觀測性分層，而不是只依賴單一 API 防護。", 13);
  const layers = [["Browser", "sessionStorage 保存 Cognito token", c.deep], ["API Gateway", "JWT authorizer、CORS、rate limit", c.teal], ["FastAPI", "role guard、schema validation、request ID", c.green], ["AWS IAM", "Lambda least privilege", c.amber], ["DynamoDB", "KMS encryption、PITR、deletion protection", c.red]];
  layers.forEach(([name, desc, accent], i) => { const y = 1.55 + i * 0.88; addBox(slide, 1.25, y, 10.65, 0.57); slide.addShape(pptx.ShapeType.rect, { x: 1.25, y, w: 0.12, h: 0.57, fill: { color: accent }, line: { color: accent } }); addText(slide, name, { x: 1.65, y: y + 0.2, w: 1.45, h: 0.13, fontSize: 9.5, bold: true, color: accent }); addText(slide, desc, { x: 3.35, y: y + 0.2, w: 5.6, h: 0.13, fontSize: 9, color: c.muted }); });
  addText(slide, "Production precondition：erp_environment=production 時，Terraform 強制要求 api_auth_enabled=true 且 seed_demo=false。", { x: 1.27, y: 6.1, w: 10.4, h: 0.18, fontSize: 9.7, bold: true, color: c.red }); footer(slide);
}

// 14 MCP
{
  const slide = newSlide("ERP MCP：讓 AI 協助查詢，但不繞過企業控制", "MCP 是獨立 stdio adapter，不直接暴露在公開 API Gateway。", 14);
  [["AI Client", "Copilot / Claude / MCP client", 0.78, c.deep], ["MCP Server", "FastMCP stdio adapter", 3.15, c.teal], ["Approval Gate", "approved=true + feature flag", 5.58, c.amber], ["ERP Domain", "同一套業務規則", 8.28, c.green], ["DynamoDB", "一致性資料層", 10.7, c.teal]].forEach(([title, detail, x, accent], i) => { addBox(slide, x, 2.08, 1.85, 1.2, { line: { color: accent, width: 1 } }); addText(slide, title, { x: x + 0.1, y: 2.42, w: 1.65, h: 0.15, fontSize: 9.5, bold: true, align: "center", color: accent }); addText(slide, detail, { x: x + 0.1, y: 2.72, w: 1.65, h: 0.25, fontSize: 7.1, color: c.muted, align: "center" }); if (i < 4) arrow(slide, x + 1.98, 2.56, 0.28); });
  [["唯讀工具（預設）", "dashboard、PO、庫存、庫存帳本查詢"], ["變更工具（雙重閘門）", "建立 PO、收料、異常處置均需 approved=true 與 ERP_MCP_MUTATIONS_ENABLED=true"], ["安全價值", "AI 可整理與建議，但沒有明確人類核准時不會寫入 ERP 資料。"]].forEach(([title, desc], i) => { const x = 0.78 + i * 4.1; addBox(slide, x, 4.35, 3.72, 1.15); addText(slide, title, { x: x + 0.25, y: 4.63, w: 2.8, h: 0.16, fontSize: 10, bold: true, color: i === 1 ? c.amber : c.teal }); addText(slide, desc, { x: x + 0.25, y: 4.98, w: 3.15, h: 0.25, fontSize: 8.1, color: c.muted }); }); footer(slide);
}

// 15 Imports
{
  const slide = newSlide("批次匯入：Excel → S3 → SQS → Lambda", "大型或定期採購資料不直接塞進同步 API，改由可靠的非同步工作流處理。", 15);
  [["Web UI", "選取 XLSX", c.deep], ["Upload URL API", "取得預簽名 URL", c.teal], ["Private S3", "上傳來源檔", c.green], ["SQS", "隔離與重試", c.amber], ["Import Worker", "建立 PO", c.teal], ["DLQ", "連續失敗保留", c.red]].forEach(([title, desc, accent], i) => { const x = 0.58 + i * 2.1; addBox(slide, x, 2.08, 1.68, 1.16, { line: { color: accent, width: 1 } }); addText(slide, title, { x: x + 0.08, y: 2.42, w: 1.52, h: 0.15, fontSize: 9, bold: true, align: "center", color: accent }); addText(slide, desc, { x: x + 0.08, y: 2.72, w: 1.52, h: 0.14, fontSize: 7, color: c.muted, align: "center" }); if (i < 5) arrow(slide, x + 1.76, 2.56, 0.2); });
  addBox(slide, 0.9, 4.22, 11.3, 1.25, { fill: { color: c.mint }, line: { color: "B9DED0", width: 0.7 } }); addText(slide, "Excel 必要欄位", { x: 1.23, y: 4.55, w: 1.4, h: 0.18, fontSize: 11, bold: true, color: c.teal }); addText(slide, "po_id · supplier_name · expected_date · material_id · material_name · ordered_quantity", { x: 2.85, y: 4.56, w: 7.7, h: 0.16, fontSize: 9.5, color: c.ink }); addText(slide, "unit 為選填；重複相同 PO 定義會略過，避免批次重送造成重複建立。", { x: 1.23, y: 4.98, w: 9.8, h: 0.14, fontSize: 8.5, color: c.muted }); footer(slide);
}

// 16 APIs
{
  const slide = newSlide("API 設計與可擴展查詢", "v2 API 提供受限制的 cursor pagination 與篩選；避免資料量成長後 dashboard 靜默漏資料。", 16);
  const apis = [["GET /health · /ready", "Liveness / DynamoDB readiness"], ["GET /api/dashboard", "KPI：PO、收料、低庫存、隔離量"], ["GET /api/v2/purchase-orders", "status / supplier + cursor"], ["GET /api/v2/inventory", "material_id / low_stock + cursor"], ["GET /api/v2/inventory-transactions", "material_id / type + cursor"], ["POST mutation APIs", "PO、receipt、resolution、adjustment、upload URL"]];
  apis.forEach(([path, purpose], i) => { const x = 0.72 + (i % 2) * 6.05; const y = 1.58 + Math.floor(i / 2) * 1.1; addBox(slide, x, y, 5.55, 0.72); addText(slide, path, { x: x + 0.25, y: y + 0.2, w: 3.4, h: 0.14, fontSize: 9.4, bold: true, color: c.teal }); addText(slide, purpose, { x: x + 3.55, y: y + 0.2, w: 1.7, h: 0.14, fontSize: 7.7, color: c.muted, align: "right" }); });
  addBox(slide, 0.72, 5.3, 11.6, 0.6, { fill: { color: c.amberBg }, line: { color: "E7C598", width: 0.7 } }); addText(slide, "Cursor 設計", { x: 1.0, y: 5.52, w: 1.1, h: 0.14, fontSize: 9, bold: true, color: c.amber }); addText(slide, "cursor 為 opaque token 並綁定當次 filter；將 cursor 拿去不同條件查詢時回 400，防止資料跳頁。", { x: 2.22, y: 5.52, w: 9.5, h: 0.14, fontSize: 8.7, color: c.ink }); footer(slide);
}

// 17 Observability and quality
{
  const slide = newSlide("品質保證與可觀測性", "測試、request correlation 與 health/readiness endpoint 讓流程可驗證也可維運。", 17);
  [["測試", ["API regression test", "收料狀態轉移", "idempotency / concurrency", "異常與庫存帳本"], c.green], ["可觀測性", ["X-Request-Id middleware", "一致的 4xx / 5xx API 回應", "/health 與 /ready", "CloudWatch logs / alarms"], c.teal], ["部署防護", ["Terraform fmt / validate / plan", "0 destroy plan 檢查", "Lambda ZIP build", "部署後 OpenAPI / UI GET"], c.amber]].forEach(([title, list, accent], i) => { const x = 0.68 + i * 4.18; addBox(slide, x, 1.72, 3.78, 3.9); addText(slide, title, { x: x + 0.3, y: 2.12, w: 2.2, h: 0.24, fontSize: 16, bold: true, color: accent }); bullets(slide, list, x + 0.31, 2.82, 3.05, accent, 9); });
  addText(slide, "品質不是測試通過而已：部署流程必須能證明它沒有意外刪除或重建持久化 ERP 資料。", { x: 0.72, y: 6.05, w: 11.5, h: 0.2, fontSize: 12, bold: true, color: c.deep }); footer(slide);
}

// 18 Cost
{
  const slide = newSlide("成本控制與部署原則", "Demo 專案優先使用按量計費、最小規格與可清理的 AWS 資源。", 18);
  [["Lambda ZIP", "Python 3.12 · x86_64 · 512 MB · 30 sec\n避免容器映像與 ECR 維運成本", c.teal], ["DynamoDB", "PAY_PER_REQUEST · TTL · 可選 PITR\n只在實際讀寫時產生成本", c.green], ["Logs", "CloudWatch retention 預設 1 天\n避免 Demo 長期累積日誌", c.amber], ["Terraform", "plan 先確認 0 destroy\nDemo 完成可明確 terraform destroy", c.red]].forEach(([title, desc, accent], i) => { const x = 0.72 + (i % 2) * 6.05; const y = 1.68 + Math.floor(i / 2) * 2.0; addBox(slide, x, y, 5.55, 1.46); slide.addShape(pptx.ShapeType.rect, { x, y, w: 0.1, h: 1.46, fill: { color: accent }, line: { color: accent } }); addText(slide, title, { x: x + 0.35, y: y + 0.31, w: 1.55, h: 0.2, fontSize: 14, bold: true, color: accent }); addText(slide, desc, { x: x + 0.35, y: y + 0.73, w: 4.4, h: 0.46, fontSize: 9.2, color: c.muted, breakLine: true }); });
  addBox(slide, 0.72, 5.83, 11.6, 0.45, { fill: { color: c.redBg }, line: { color: "E8BBB7", width: 0.6 } }); addText(slide, "限制：不要加入 AWS Organizations 以追求免費額度；先建立 AWS Budget 警示，再進行 Demo 部署。", { x: 1.03, y: 5.99, w: 10.85, h: 0.13, fontSize: 8.8, bold: true, color: c.red }); footer(slide);
}

// 19 Demo script
{
  const slide = newSlide("建議 Demo 腳本：5 分鐘展示完整異常閉環", "以一張 100 pcs PO 為例，展示前端操作與後端資料控制。", 19);
  const demo = [["1", "登入", "貼上 Cognito ID Token，確認 warehouse / purchaser / approver 角色"], ["2", "建立 PO", "建立 100 pcs Demo PO，進入待驗收工作佇列"], ["3", "部分收料", "輸入 80 pcs，PO -> 待處理異常，庫存與 Ledger +80"], ["4", "處置補貨", "approver 選補貨，填寫供應商承諾；PO -> 待補貨"], ["5", "補收 20 pcs", "表單顯示剩餘待收，完成後 PO -> 已完成，Ledger +20"], ["6", "驗證控制", "重送相同 idempotency request 不重複入帳；查看帳本與 alert" ]];
  demo.forEach(([number, action, detail], i) => { const y = 1.53 + i * 0.79; slide.addShape(pptx.ShapeType.ellipse, { x: 0.95, y: y + 0.04, w: 0.34, h: 0.34, fill: { color: i === 2 ? c.amber : c.teal }, line: { color: i === 2 ? c.amber : c.teal } }); addText(slide, number, { x: 1.04, y: y + 0.15, w: 0.16, h: 0.08, fontSize: 6.2, bold: true, align: "center", color: c.white }); addText(slide, action, { x: 1.6, y, w: 1.65, h: 0.18, fontSize: 10.5, bold: true }); addText(slide, detail, { x: 3.42, y, w: 7.4, h: 0.2, fontSize: 9.4, color: c.muted }); pill(slide, i === 2 ? "異常流程" : i === 5 ? "稽核證明" : "操作", 11.05, y - 0.02, 1.12, i === 2 ? c.amberBg : c.mint, i === 2 ? c.amber : c.teal); }); footer(slide);
}

// 20 Roadmap
{
  const slide = newSlide("Roadmap 與履歷價值", "下一步將收料 MVP 往完整採購、品質與應付帳款流程延伸。", 20);
  [["已完成", ["Serverless ERP 收料與異常閉環", "RBAC、MCP approval gate", "Outbox、帳本、匯入、分頁"], c.green], ["下一個里程碑", ["Quality Inspection 與不合格隔離", "Return to Vendor 退貨流程", "Supplier / Material Master"], c.teal], ["企業級延伸", ["GRN / PO / Invoice 三方匹配", "應付帳款與付款整合", "自訂網域、CDN、WAF 與 BI"], c.amber]].forEach(([title, list, accent], i) => { const x = 0.68 + i * 4.18; addBox(slide, x, 1.6, 3.78, 3.32); slide.addShape(pptx.ShapeType.rect, { x, y: 1.6, w: 3.78, h: 0.12, fill: { color: accent }, line: { color: accent } }); addText(slide, title, { x: x + 0.3, y: 2.0, w: 2.6, h: 0.24, fontSize: 16, bold: true, color: accent }); bullets(slide, list, x + 0.31, 2.65, 3.02, accent, 8.8); });
  addBox(slide, 0.68, 5.45, 12, 0.65, { fill: { color: c.deep }, line: { color: c.deep } }); addText(slide, "履歷敘述：Designed and deployed an AWS serverless ERP receiving and exception-management module with FastAPI, API Gateway, Lambda, DynamoDB transactions, Cognito RBAC, SNS outbox retry, Terraform, and approval-gated MCP tools.", { x: 0.98, y: 5.68, w: 11.4, h: 0.16, fontSize: 8.2, color: c.white, bold: true }); footer(slide, "AWS Serverless ERP · Procurement, Receiving & Exception Management");
}

await pptx.writeFile({ fileName: "/home/shaok/aaa/AWS-Serverless-ERP/AWS_Serverless_ERP_Complete_Presentation.pptx" });
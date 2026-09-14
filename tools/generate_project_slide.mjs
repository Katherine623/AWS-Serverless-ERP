import pptxgen from "/tmp/erp-slide-deps/node_modules/pptxgenjs/dist/pptxgen.cjs.js";

const pptx = new pptxgen();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "AWS Serverless ERP";
pptx.subject = "AWS Serverless ERP Receiving and Exception Management";
pptx.title = "AWS Serverless ERP | 專案總覽";
pptx.company = "Portfolio Project";
pptx.lang = "zh-TW";
pptx.theme = {
  headFontFace: "Noto Sans TC",
  bodyFontFace: "Noto Sans TC",
  lang: "zh-TW",
};

const slide = pptx.addSlide();
const color = {
  ink: "123B3B",
  muted: "5D7772",
  canvas: "F3F6F1",
  panel: "FFFEFA",
  border: "D9E5DE",
  teal: "007C70",
  deepTeal: "07584F",
  green: "1B8A61",
  amber: "C97822",
  red: "C64E45",
  white: "FFFFFF",
};

const addText = (text, options) => slide.addText(text, {
  fontFace: "Noto Sans TC",
  color: color.ink,
  margin: 0,
  breakLine: false,
  fit: "shrink",
  ...options,
});

const roundedPanel = (x, y, w, h) => slide.addShape(pptx.ShapeType.roundRect, {
  x, y, w, h,
  rectRadius: 0.08,
  fill: { color: color.panel },
  line: { color: color.border, width: 0.8 },
  shadow: { type: "outer", color: "B8C9BE", opacity: 0.12, blur: 1, angle: 45, distance: 1 },
});

slide.background = { color: color.canvas };
slide.addShape(pptx.ShapeType.rect, {
  x: 0, y: 0, w: 13.333, h: 0.08,
  fill: { color: color.teal }, line: { color: color.teal },
});

addText("AWS SERVERLESS ERP / PROCUREMENT & RECEIVING", {
  x: 0.62, y: 0.42, w: 5.3, h: 0.22,
  fontSize: 8.5, bold: true, charSpacing: 1.2, color: color.teal,
});
addText("從採購單到異常結案的可追溯收料流程", {
  x: 0.62, y: 0.7, w: 8.7, h: 0.48,
  fontSize: 23, bold: true, color: color.ink,
});
addText("以 Serverless 架構實作部分收料、補貨處置、庫存帳本與即時警示", {
  x: 0.64, y: 1.22, w: 7.8, h: 0.25,
  fontSize: 10.5, color: color.muted,
});

slide.addShape(pptx.ShapeType.roundRect, {
  x: 10.37, y: 0.62, w: 2.28, h: 0.62,
  rectRadius: 0.12, fill: { color: "E1F1EA" }, line: { color: "B9DED0", width: 0.7 },
});
addText("部署中 / Portfolio MVP", {
  x: 10.58, y: 0.82, w: 1.9, h: 0.2,
  fontSize: 9, bold: true, align: "center", color: color.green,
});

roundedPanel(0.62, 1.76, 4.02, 4.75);
addText("ERP 業務閉環", { x: 0.9, y: 2.05, w: 2.3, h: 0.28, fontSize: 15, bold: true });
addText("可操作的採購收料與例外管理", {
  x: 0.9, y: 2.38, w: 3.25, h: 0.2, fontSize: 9, color: color.muted,
});

const steps = [
  ["01", "建立採購單", "料號與單位主檔一致性驗證", color.teal],
  ["02", "部分 / 全數收料", "僅收剩餘待收量，防止超收", color.teal],
  ["03", "異常處置", "補貨或差異允收結案，保存責任與說明", color.amber],
  ["04", "可稽核結案", "收料、庫存與處置資料完整追溯", color.green],
];
steps.forEach(([number, title, detail, accent], index) => {
  const y = 2.78 + index * 0.78;
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 0.91, y, w: 0.37, h: 0.37,
    fill: { color: accent }, line: { color: accent },
  });
  addText(number, { x: 0.95, y: y + 0.11, w: 0.29, h: 0.12, fontSize: 6.5, bold: true, align: "center", color: color.white });
  addText(title, { x: 1.45, y: y - 0.02, w: 2.55, h: 0.22, fontSize: 11, bold: true });
  addText(detail, { x: 1.45, y: y + 0.25, w: 2.74, h: 0.18, fontSize: 7.8, color: color.muted });
  if (index < steps.length - 1) {
    slide.addShape(pptx.ShapeType.line, { x: 1.095, y: y + 0.4, w: 0, h: 0.36, line: { color: color.border, width: 1.1 } });
  }
});

roundedPanel(4.88, 1.76, 4.0, 4.75);
addText("AWS Serverless 架構", { x: 5.16, y: 2.05, w: 2.8, h: 0.28, fontSize: 15, bold: true });
addText("低維運成本、可擴展的交易服務", { x: 5.16, y: 2.38, w: 3.2, h: 0.2, fontSize: 9, color: color.muted });

const architecture = [
  ["Web Dashboard", "採購、收料、異常處置", color.deepTeal],
  ["API Gateway + Lambda", "FastAPI + 輸入與狀態驗證", color.teal],
  ["DynamoDB Transaction", "PO / Receipt / Inventory / Ledger", color.green],
  ["SNS + CloudWatch", "營運警示與短期日誌保留", color.amber],
];
architecture.forEach(([title, detail, accent], index) => {
  const y = 2.78 + index * 0.76;
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 5.16, y, w: 3.42, h: 0.53, rectRadius: 0.06,
    fill: { color: index % 2 === 0 ? "F7FAF7" : "EEF5F1" }, line: { color: color.border, width: 0.5 },
  });
  slide.addShape(pptx.ShapeType.rect, { x: 5.16, y, w: 0.07, h: 0.53, fill: { color: accent }, line: { color: accent } });
  addText(title, { x: 5.4, y: y + 0.11, w: 1.9, h: 0.15, fontSize: 9, bold: true });
  addText(detail, { x: 5.4, y: y + 0.29, w: 2.88, h: 0.12, fontSize: 7.3, color: color.muted });
  if (index < architecture.length - 1) {
    slide.addShape(pptx.ShapeType.chevron, { x: 6.83, y: y + 0.56, w: 0.16, h: 0.12, fill: { color: color.border }, line: { color: color.border } });
  }
});

roundedPanel(9.12, 1.76, 3.53, 4.75);
addText("可靠性設計", { x: 9.4, y: 2.05, w: 2.2, h: 0.28, fontSize: 15, bold: true });
addText("避免重複入帳與不可解釋的庫存", {
  x: 9.4, y: 2.38, w: 2.8, h: 0.2, fontSize: 9, color: color.muted,
});

const reliability = [
  ["Idempotency-Key", "安全重試，不重複增加庫存"],
  ["Optimistic Locking", "並行收料衝突回應 409"],
  ["Inventory Ledger", "每筆收料建立不可省略的帳本"],
  ["Validation Guardrails", "防重複料號、超收與全零收料"],
  ["Audit Trail", "保存異常處置人、理由與差異數量"],
];
reliability.forEach(([title, detail], index) => {
  const y = 2.78 + index * 0.62;
  slide.addShape(pptx.ShapeType.ellipse, { x: 9.42, y: y + 0.04, w: 0.14, h: 0.14, fill: { color: color.green }, line: { color: color.green } });
  addText(title, { x: 9.69, y, w: 2.45, h: 0.16, fontSize: 8.7, bold: true });
  addText(detail, { x: 9.69, y: y + 0.21, w: 2.5, h: 0.13, fontSize: 7.2, color: color.muted });
});

slide.addShape(pptx.ShapeType.line, { x: 0.63, y: 6.8, w: 12.02, h: 0, line: { color: color.border, width: 0.8 } });
addText("履歷亮點", { x: 0.64, y: 6.98, w: 0.9, h: 0.16, fontSize: 8.5, bold: true, color: color.teal });
addText("FastAPI  |  AWS Lambda  |  API Gateway  |  DynamoDB Transactions  |  SNS  |  Terraform", {
  x: 1.62, y: 6.98, w: 8.2, h: 0.16, fontSize: 8.5, color: color.ink,
});
addText("AWS Serverless ERP Receiving & Exception Management", {
  x: 9.08, y: 6.98, w: 3.55, h: 0.16, fontSize: 7.5, align: "right", color: color.muted,
});

await pptx.writeFile({ fileName: "/home/shaok/aaa/AWS-Serverless-ERP/AWS_Serverless_ERP_Overview.pptx" });
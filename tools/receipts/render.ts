// Spec -> HTML of a thermal receipt on a desk. The page also carries the "photo"
// step (perspective, blur, light, creases, noise), run in the browser by
// `window.__photo(params)` so no native imaging library is needed.

import type { ReceiptSpec, SpecLine } from "./spec";
import type { Locale } from "./scenario";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const group = (n: number, sep: string) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
function decimal(minor: number, thousands: string, point: string): string {
  const abs = Math.abs(minor);
  const whole = group(Math.floor(abs / 100), thousands);
  return `${minor < 0 ? "-" : ""}${whole}${point}${String(abs % 100).padStart(2, "0")}`;
}

export const fmtMoney: Record<Locale, (minor: number) => string> = {
  ja: (m) => `${m < 0 ? "-" : ""}¥${group(Math.abs(m), ",")}`,
  tr: (m) => decimal(m, ".", ","),
  es: (m) => decimal(m, ".", ","),
  en: (m) => `${m < 0 ? "-" : ""}$${decimal(Math.abs(m), ",", ".")}`,
};

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

function fmtDate(locale: Locale, iso: string): string {
  const [d, t] = iso.split("T");
  const [y, mo, da] = d.split("-");
  const hm = t.slice(0, 5);
  if (locale === "ja") {
    const wd = WEEKDAY_JA[new Date(Date.UTC(+y, +mo - 1, +da)).getUTCDay()];
    return `${y}年${mo}月${da}日(${wd}) ${hm}`;
  }
  if (locale === "tr") return `${da}.${mo}.${y}  ${hm}`;
  if (locale === "es") return `${da}/${mo}/${y} ${hm}`;
  const h = +hm.slice(0, 2);
  return `${mo}/${da}/${y} ${String((h + 11) % 12 + 1).padStart(2, "0")}:${hm.slice(3)} ${h < 12 ? "AM" : "PM"}`;
}

type Rows = string[];
// Both sides always carry text, so baseline alignment never meets an empty box.
const row = (l: string, r = "", cls = "") => `<div class="row ${cls}"><span class="l">${l || "&nbsp;"}</span><span class="r">${r || "&nbsp;"}</span></div>`;
const center = (t: string, cls = "") => `<div class="c ${cls}">${t}</div>`;
const sep = (cls = "") => `<div class="sep ${cls}"></div>`;

/** Wraps a personal-data string so the browser can report where it sits. */
function piiSpan(spec: ReceiptSpec, kind: ReceiptSpec["pii"][number]["kind"]): string {
  const i = spec.pii.findIndex((p) => p.kind === kind);
  return i < 0 ? "" : `<span data-pii="${i}">${esc(spec.pii[i].text)}</span>`;
}

function header(spec: ReceiptSpec): Rows {
  const s = spec.store;
  const out: Rows = [center(esc(s.name), "store")];
  if (s.branch) out.push(center(esc(s.branch), "branch"));
  for (const a of s.address) out.push(center(esc(a)));
  out.push(center(`TEL ${esc(s.phone)}`));
  if (s.taxId) out.push(center(spec.locale === "ja" ? `登録番号 ${esc(s.taxId)}` : esc(s.taxId)));
  return out;
}

// ------------------------------------------------------------------ Japan

function jaLine(l: SpecLine): Rows {
  const amount = `${fmtMoney.ja(l.amountMinor)}${l.taxRateBp === 800 ? "※" : ""}`;
  const out: Rows = [row(esc(l.name[0]), amount)];
  for (const extra of l.name.slice(1)) out.push(row(`&nbsp;&nbsp;${esc(extra)}`, "", "sub"));
  if (l.qty && l.qty > 1 && l.unitMinor !== null) out.push(row(`&nbsp;&nbsp;${l.qty}点 x 単${fmtMoney.ja(l.unitMinor).replace("¥", "")}`, "", "sub"));
  return out;
}

function ja(spec: ReceiptSpec): Rows {
  const m = fmtMoney.ja;
  const items = spec.lines.filter((l) => !l.discount).length;
  const out: Rows = [...header(spec), sep()];
  out.push(row(fmtDate("ja", spec.purchasedAt), ""), row(`レジ${spec.register}`, `No.${spec.receiptNumber}`), sep());
  for (const l of spec.lines) out.push(...jaLine(l));
  out.push(sep());
  out.push(row(`小計 (${items}点)`, m(spec.subtotalMinor ?? 0), "big"));
  const untaxed = spec.lines.filter((l) => l.taxRateBp === null).reduce((s, l) => s + l.amountMinor, 0);
  if (spec.taxIncluded) {
    for (const t of spec.taxByRate) out.push(row(`${t.rateBp / 100}%対象`, m(t.baseMinor)));
    if (untaxed) out.push(row("非課税対象", m(untaxed)));
    for (const t of spec.taxByRate) out.push(row(`(内消費税等 ${t.rateBp / 100}%`, `${m(t.taxMinor)})`, "sub"));
  } else {
    for (const t of spec.taxByRate) out.push(row(`外税${t.rateBp / 100}% 対象 ${m(t.baseMinor)}`, `消費税 ${m(t.taxMinor)}`));
    if (untaxed) out.push(row("非課税対象", m(untaxed)));
  }
  out.push(row("合計", m(spec.totalMinor), "total"));
  const p = spec.payment;
  if (p.method === "cash") out.push(row("お預り", m(p.tenderedMinor!)), row("お釣り", m(p.changeMinor!)));
  else out.push(row("クレジット", piiSpan(spec, "card_number")), row("お支払い", m(spec.totalMinor)));
  if (spec.pii.some((x) => x.kind === "name")) {
    out.push(sep("dots"), row("ポイントカード", ""), row(`${piiSpan(spec, "name")} 様`, ""), row("会員番号", piiSpan(spec, "member_id")));
  }
  if (spec.lines.some((l) => l.taxRateBp === 800)) out.push(sep("dots"), center("※は軽減税率(8%)対象商品です", "small"));
  out.push(center("ご来店ありがとうございました", "small"));
  return out;
}

// ----------------------------------------------------------------- Turkey

function trLine(l: SpecLine): Rows {
  const tag = l.taxRateBp === null ? "" : `<span class="tag">%${String(l.taxRateBp / 100).padStart(2, "0")}</span> `;
  const out: Rows = [row(esc(l.name[0]), `${tag}*${fmtMoney.tr(l.amountMinor)}`)];
  for (const extra of l.name.slice(1)) out.push(row(`&nbsp;&nbsp;${esc(extra)}`, "", "sub"));
  if (l.qty && l.qty > 1 && l.unitMinor !== null) out.push(row(`&nbsp;&nbsp;${l.qty} x ${fmtMoney.tr(l.unitMinor)}`, "", "sub"));
  return out;
}

function tr(spec: ReceiptSpec): Rows {
  const m = fmtMoney.tr;
  const out: Rows = [...header(spec), sep()];
  out.push(row(`TARİH: ${fmtDate("tr", spec.purchasedAt)}`, `FİŞ NO: ${spec.receiptNumber}`), sep());
  for (const l of spec.lines) out.push(...trLine(l));
  out.push(sep());
  for (const t of spec.taxByRate) out.push(row(`KDV %${t.rateBp / 100}  MATRAH ${m(t.baseMinor - t.taxMinor)}`, `*${m(t.taxMinor)}`, "sub"));
  out.push(row("TOPKDV", `*${m(spec.taxMinor)}`), row("TOPLAM", `*${m(spec.totalMinor)}`, "total"));
  const p = spec.payment;
  if (p.method === "cash") out.push(row("NAKİT", `*${m(p.tenderedMinor!)}`), row("PARA ÜSTÜ", `*${m(p.changeMinor!)}`));
  else out.push(row("KREDİ KARTI", `*${m(spec.totalMinor)}`), row(piiSpan(spec, "card_number"), ""));
  if (spec.pii.some((x) => x.kind === "name")) out.push(sep("dots"), row("MÜŞTERİ KARTI", piiSpan(spec, "member_id")), row(piiSpan(spec, "name"), ""));
  out.push(center("TEŞEKKÜR EDERİZ", "small"));
  return out;
}

// ------------------------------------------------------------------ Spain

function esLine(l: SpecLine, code: string): Rows {
  const out: Rows = [row(esc(l.name[0]), `${fmtMoney.es(l.amountMinor)} ${code}`)];
  for (const extra of l.name.slice(1)) out.push(row(`&nbsp;&nbsp;${esc(extra)}`, "", "sub"));
  if (l.qty && l.qty > 1 && l.unitMinor !== null) out.push(row(`&nbsp;&nbsp;${l.qty} x ${fmtMoney.es(l.unitMinor)}`, "", "sub"));
  return out;
}

function es(spec: ReceiptSpec): Rows {
  const m = fmtMoney.es;
  const codes = new Map(spec.taxByRate.map((t, i) => [t.rateBp, "ABCDE"[i]]));
  const out: Rows = [...header(spec), sep()];
  out.push(row(`FACTURA SIMPLIFICADA`, `Nº ${spec.receiptNumber}`), row(fmtDate("es", spec.purchasedAt), `CAJA ${spec.register}`), sep());
  out.push(row("DESCRIPCIÓN", "IMPORTE", "sub"));
  for (const l of spec.lines) out.push(...esLine(l, l.taxRateBp === null ? "&nbsp;" : codes.get(l.taxRateBp) ?? "&nbsp;"));
  out.push(sep());
  out.push(row("TOTAL (IVA INCLUIDO)", `${m(spec.totalMinor)} EUR`, "total"));
  for (const t of spec.taxByRate) out.push(row(`${codes.get(t.rateBp)}  IVA ${t.rateBp / 100}%  BASE ${m(t.baseMinor - t.taxMinor)}`, `CUOTA ${m(t.taxMinor)}`, "sub"));
  const p = spec.payment;
  if (p.method === "cash") out.push(row("EFECTIVO", m(p.tenderedMinor!)), row("CAMBIO", m(p.changeMinor!)));
  else out.push(row("PAGO TARJETA", m(spec.totalMinor)), row(piiSpan(spec, "card_number"), ""));
  if (spec.pii.some((x) => x.kind === "name")) out.push(sep("dots"), row("SOCIO", piiSpan(spec, "member_id")), row(piiSpan(spec, "name"), ""));
  out.push(center("GRACIAS POR SU VISITA", "small"));
  return out;
}

// ----------------------------------------------------------------- US

function enLine(l: SpecLine): Rows {
  const mark = l.discount ? "" : l.taxRateBp === null ? "F" : "T";
  const out: Rows = [row(esc(l.name[0]), `${fmtMoney.en(l.amountMinor)} ${mark}`.trim())];
  for (const extra of l.name.slice(1)) out.push(row(`&nbsp;&nbsp;${esc(extra)}`, "", "sub"));
  if (l.qty && l.qty > 1 && l.unitMinor !== null) out.push(row(`&nbsp;&nbsp;${l.qty} @ ${fmtMoney.en(l.unitMinor)}`, "", "sub"));
  return out;
}

function en(spec: ReceiptSpec): Rows {
  const m = fmtMoney.en;
  const out: Rows = [...header(spec), sep()];
  out.push(row(fmtDate("en", spec.purchasedAt), `REG ${spec.register}`), row(`TRANS #${spec.receiptNumber}`, ""), sep());
  for (const l of spec.lines) out.push(...enLine(l));
  out.push(sep());
  out.push(row("SUBTOTAL", m(spec.subtotalMinor ?? 0)), row("SALES TAX 7.25%", m(spec.taxMinor)), row("TOTAL", m(spec.totalMinor), "total"));
  const p = spec.payment;
  if (p.method === "cash") out.push(row("CASH", m(p.tenderedMinor!)), row("CHANGE", m(p.changeMinor!)));
  else out.push(row("VISA", piiSpan(spec, "card_number")), row("APPROVED", m(spec.totalMinor)));
  if (spec.pii.some((x) => x.kind === "name")) out.push(sep("dots"), row("REWARDS MEMBER", ""), row(piiSpan(spec, "name"), ""), row("MEMBER #", piiSpan(spec, "member_id")));
  out.push(center("T = TAXABLE  F = NON-TAXABLE", "small"), center("THANK YOU - COME AGAIN", "small"));
  return out;
}

const BODY: Record<Locale, (s: ReceiptSpec) => Rows> = { ja, tr, es, en };

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#222}
.stage{position:relative;overflow:hidden;width:1400px;height:3000px}
.scene{position:absolute;inset:0}
.wrap{position:absolute;filter:drop-shadow(0 14px 18px rgba(0,0,0,.55)) drop-shadow(0 2px 3px rgba(0,0,0,.4))}
.paper{position:relative;width:440px;padding:28px 24px 38px;background:#f5f2e9;color:#25252a;
  font:15px/1.6 Menlo,"Hiragino Kaku Gothic ProN","Hiragino Sans","Courier New",monospace;overflow:hidden;
  text-shadow:0 0 .7px rgba(20,20,20,.35)}
.paper .row{display:flex;justify-content:space-between;align-items:baseline;gap:14px;white-space:pre-wrap}
.paper .row .l{flex:1 1 auto;min-width:0}
.paper .row .r{flex:0 0 auto;text-align:right}
.paper .c{text-align:center}
.paper .store{font-size:20px;font-weight:700;letter-spacing:.5px;margin-bottom:2px}
.paper .branch{font-size:17px;font-weight:600}
.paper .small{font-size:12px;opacity:.85}
.paper .sub{font-size:13px;opacity:.9}
.paper .tag{font-size:12px}
.paper .big{font-weight:700}
.paper .total{font-weight:700;font-size:18px;margin-top:4px}
.paper .sep{border-top:2px dashed rgba(30,30,30,.55);margin:9px 0}
.paper .sep.dots{border-top-style:dotted}
.crease{position:absolute;pointer-events:none}
.light,.glare,.noise{position:absolute;inset:0;pointer-events:none}
`;

const PHOTO_JS = String.raw`
window.__photo = function (p) {
  function mulberry(a){return function(){a=(a+0x6d2b79f5)>>>0;var t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
  var rng = mulberry(p.seed);
  var stage = document.querySelector('.stage'), scene = document.querySelector('.scene');
  var wrap = document.querySelector('.wrap'), paper = document.querySelector('.paper');
  var pw = paper.offsetWidth, ph = paper.offsetHeight;
  // Jagged tear at the top and bottom of the paper.
  var pts = [], x, step = 8;
  for (x = 0; x <= pw; x += step) pts.push(x + 'px ' + (rng() * 3.5).toFixed(1) + 'px');
  for (x = pw; x >= 0; x -= step) pts.push(x + 'px ' + (ph - rng() * 3.5).toFixed(1) + 'px');
  paper.style.clipPath = 'polygon(' + pts.join(',') + ')';
  // Creases: soft light/dark bands across the paper.
  p.creases.forEach(function (c) {
    var d = document.createElement('div'); d.className = 'crease';
    var len = c.length;
    d.style.cssText = 'left:' + (c.x * pw - c.width / 2) + 'px;top:' + (c.y * ph - len / 2) + 'px;width:' + c.width + 'px;height:' + len + 'px;' +
      'transform:rotate(' + c.angle + 'deg);-webkit-mask-image:linear-gradient(transparent,#000 25%,#000 75%,transparent);' +
      'background:linear-gradient(90deg,transparent,rgba(0,0,0,' + c.strength + ') 40%,rgba(255,255,255,' + (c.strength * 1.8) + ') 60%,transparent)';
    paper.appendChild(d);
  });
  var curl = document.createElement('div'); curl.className = 'crease';
  curl.style.cssText = 'inset:0;background:linear-gradient(90deg,rgba(0,0,0,.10),transparent 12%,transparent 88%,rgba(0,0,0,.12))';
  paper.appendChild(curl);
  // Stage size: room for the rotated paper.
  var rz = Math.abs(p.rotZ) * Math.PI / 180;
  var W = Math.ceil(pw * Math.cos(rz) + ph * Math.sin(rz)) + 150;
  var H = Math.ceil(ph * Math.cos(rz) + pw * Math.sin(rz)) + 150;
  stage.style.width = W + 'px'; stage.style.height = H + 'px';
  var desks = {
    wood: 'repeating-linear-gradient(92deg,#6b4f35 0,#6b4f35 3px,#5d4530 3px,#5d4530 7px,#71563b 7px,#71563b 9px)',
    slate: 'linear-gradient(135deg,#3b4047,#2d3136)',
    cloth: 'repeating-linear-gradient(45deg,#9aa0a8 0,#9aa0a8 6px,#8f959d 6px,#8f959d 12px)'
  };
  scene.style.background = desks[p.desk];
  scene.style.filter = 'blur(' + p.blurPx + 'px)';
  wrap.style.left = ((W - pw) / 2) + 'px'; wrap.style.top = ((H - ph) / 2) + 'px';
  wrap.style.transform = 'perspective(' + p.perspective + 'px) rotateX(' + p.rotX + 'deg) rotateY(' + p.rotY + 'deg) rotateZ(' + p.rotZ + 'deg)';
  // Uneven light and one glare patch.
  var light = document.createElement('div'); light.className = 'light';
  light.style.background = 'linear-gradient(' + p.lightAngle + 'deg,rgba(0,0,0,0),rgba(0,0,0,' + p.lightStrength + '))';
  var glare = document.createElement('div'); glare.className = 'glare';
  glare.style.background = 'radial-gradient(ellipse at ' + (p.glare.x * 100) + '% ' + (p.glare.y * 100) + '%,rgba(255,250,225,' + p.glare.strength + '),rgba(255,250,225,0) 55%)';
  stage.appendChild(light); stage.appendChild(glare);
  // Sensor noise in 2x2 blocks (keeps the PNG small).
  var cv = document.createElement('canvas'); cv.className = 'noise'; cv.width = W; cv.height = H;
  var ctx = cv.getContext('2d'), img = ctx.createImageData(W, H), bw = Math.ceil(W / 2), row = new Float32Array(bw);
  for (var y = 0; y < H; y++) {
    if (y % 2 === 0) for (var bx = 0; bx < bw; bx++) row[bx] = (rng() * 2 - 1) * p.noise;
    for (var xx = 0; xx < W; xx++) {
      var v = row[xx >> 1], i = (y * W + xx) * 4, dark = v < 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = dark ? 0 : 255;
      img.data[i + 3] = Math.round(Math.abs(v) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  stage.appendChild(cv);
  return { width: W, height: H };
};
window.__piiBoxes = function () {
  var st = document.querySelector('.stage').getBoundingClientRect(), out = {};
  document.querySelectorAll('[data-pii]').forEach(function (el) {
    var r = el.getBoundingClientRect();
    out[el.getAttribute('data-pii')] = { x: (r.left - st.left) / st.width, y: (r.top - st.top) / st.height, w: r.width / st.width, h: r.height / st.height };
  });
  return out;
};
`;

export function renderHtml(spec: ReceiptSpec): string {
  const lang = { ja: "ja", tr: "tr", es: "es", en: "en" }[spec.locale];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(spec.id)}</title><style>${CSS}</style></head>
<body><div class="stage"><div class="scene"><div class="wrap"><div class="paper">${BODY[spec.locale](spec).join("\n")}</div></div></div></div>
<script>${PHOTO_JS}</script></body></html>`;
}

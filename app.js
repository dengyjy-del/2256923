'use strict';
/* Chart Studio — симулятор торгового графика для записи видео.
   Без внешних библиотек: только canvas. */

(function () {

/* ══════════ Утилиты ══════════ */

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const num = (sel) => parseFloat($(sel).value);

let _seed = (Date.now() ^ 0x5f3759df) >>> 0;
function rnd() { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 4294967296; }
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function easeInOut(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }

const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
const TF_RU = { '1m': '1м', '5m': '5м', '15m': '15м', '30m': '30м', '1h': '1ч', '4h': '4ч', '1d': '1D' };
const MONO = 'ui-monospace,Menlo,Consolas,monospace';
const UI_FONT = '"Trebuchet MS",-apple-system,"Segoe UI",Roboto,Arial,sans-serif';

let DEC = 2;
function calcDec(p) {
  const a = Math.abs(p);
  if (a >= 100) return 2;
  if (a >= 1) return 3;
  if (a >= 0.1) return 4;
  if (a >= 0.01) return 5;
  if (a >= 0.001) return 6;
  return 8;
}
function fmt(p, d) {
  d = d === undefined ? DEC : d;
  if (!isFinite(p)) return '—';
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtVol(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(0);
}
function fmtSigned(v, d) {
  return (v >= 0 ? '+' : '−') + fmt(Math.abs(v), d === undefined ? 2 : d);
}
function fmtTime(ts, tfMs) {
  const dt = new Date(ts);
  const p2 = (n) => String(n).padStart(2, '0');
  if (tfMs >= 864e5) {
    const m = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    return p2(dt.getDate()) + ' ' + m[dt.getMonth()];
  }
  return p2(dt.getHours()) + ':' + p2(dt.getMinutes());
}

/* ══════════ Состояние ══════════ */

const HISTORY = 300;
const TICKS = 45;

const S = {
  symbol: 'BTCUSDT',
  tf: '15m', tfMs: TF_MS['15m'],
  low: 61000, high: 69000,
  volMult: 1,
  maxCandle: 0,
  candles: [],
  running: false,
  candleMs: 1500,
  tickInCandle: 0,
  barSpacing: 7,
  scrollRight: 0,
  autoScroll: true,
  band: { lo: 61000, hi: 69000 },
  sigmaTick: 1,
  volUnit: 120,
  target: null,
  showTarget: false,
  vZoom: 1,
  plotW: 0, plotH: 0,
  axisDrag: null,
  showPosCard: true,
  showPosDetails: true,
  showPosLabel: true,
  showOhlc: true,
  watermark: false,
  useLiq: true,
  position: null,
  cross: null,
  scale: { min: 0, max: 1, ready: false },
  drag: null,
  count: null,
};

/* ══════════ Генерация ══════════ */

function sigmaFor() {
  return Math.abs(S.high - S.low) * 0.026 * S.volMult / Math.sqrt(TICKS);
}
function perCandleSigma() { return sigmaFor() * Math.sqrt(TICKS); }

// Ограничение хода одной свечи: цена не может выйти за High−Low = maxCandle
function limitInCandle(p, hi, lo) {
  const m = S.maxCandle;
  if (!(m > 0)) return p;
  return clamp(p, hi - m, lo + m);
}

function genHistory(anchor) {
  const lo = Math.min(S.low, S.high), hi = Math.max(S.low, S.high);
  S.band = { lo, hi };
  S.sigmaTick = sigmaFor();
  DEC = calcDec((lo + hi) / 2);
  S.volUnit = Math.max(1, (lo + hi) / 2 * 0.0004);

  let p = (lo + hi) / 2 + (rnd() - 0.5) * (hi - lo) * 0.5;
  const t0 = Math.floor(Date.now() / S.tfMs) * S.tfMs - (HISTORY - 1) * S.tfMs;

  const out = [];
  for (let i = 0; i < HISTORY; i++) {
    const o = p;
    let h = p, l = p;
    for (let k = 0; k < TICKS; k++) {
      p = limitInCandle(freeStep(p), h, l);
      if (p > h) h = p;
      if (p < l) l = p;
    }
    out.push({
      t: t0 + i * S.tfMs, o, h, l, c: p,
      v: S.volUnit * TICKS * (0.4 + rnd() * 1.2) * (1 + Math.abs(p - o) / (hi - lo) * 4)
    });
  }

  // подгоняем хвост истории под стартовую цену
  const typed = num('#inStart');
  const wanted = isFinite(typed) && typed > 0 ? typed : anchor;
  if (isFinite(wanted) && wanted > 0) {
    const err = wanted - out[out.length - 1].c;
    for (let i = 0; i < out.length; i++) {
      const k = err * Math.pow(i / (out.length - 1), 1.6);
      const c = out[i];
      c.o += k; c.h += k; c.l += k; c.c += k;
    }
  }

  // коридор блуждания должен содержать текущую цену, иначе следующий тик дёрнет график
  const endC = out[out.length - 1].c;
  if (endC > hi || endC < lo) {
    const spread = Math.abs(hi - lo) * 0.35;
    S.band = { lo: endC - spread, hi: endC + spread };
  }

  S.candles = out;
  S.tickInCandle = 0;
  S.autoScroll = true;
  S.scale.ready = false;
}

function freeStep(p) {
  const { lo, hi } = S.band;
  const mid = (lo + hi) / 2;
  let np = p + gauss() * S.sigmaTick + (mid - p) * 0.00003;
  // упругий отбой от границ: у края — отражение, далеко за краем — плавный возврат
  if (np > hi) np -= Math.min((np - hi) * 1.7, S.sigmaTick * 3);
  else if (np < lo) np += Math.min((lo - np) * 1.7, S.sigmaTick * 3);
  return Math.max(np, 1e-9);
}

/* ══════════ Цель ══════════ */

function pathValue(T, p) {
  const d = T.price - T.start;
  switch (T.style) {
    case 'smooth':
      return T.start + d * easeInOut(p);
    case 'impulse': {
      const e = p < 0.62 ? (p / 0.62) * 0.1 : 0.1 + easeInOut((p - 0.62) / 0.38) * 0.9;
      return T.start + d * e;
    }
    case 'vshape': {
      const e = p < 0.4 ? -0.28 * Math.sin(Math.PI * p / 0.4) : easeInOut((p - 0.4) / 0.6);
      return T.start + d * e;
    }
    default: {
      const base = T.start + d * easeInOut(p);
      return base - d * 0.14 * Math.sin(2 * Math.PI * p * 1.5) * (1 - p);
    }
  }
}

function setTarget() {
  const price = num('#inTarget');
  const bars = Math.round(num('#inBars'));
  if (!isFinite(price) || price <= 0) { toast('Укажи цену цели', 'red'); return; }
  if (!isFinite(bars) || bars < 1) { toast('Укажи количество свечей', 'red'); return; }

  const start = lastPrice();
  const dist = Math.abs(price - start);

  // при ограниченном размере свечи цель может быть недостижима за N свечей
  if (S.maxCandle > 0) {
    const need = Math.ceil(dist / (S.maxCandle * 0.9));
    if (bars < need) {
      toast('Свеча не больше ' + fmt(S.maxCandle) + ' — нужно минимум ' + need + ' свечей', 'red');
      return;
    }
  }

  S.target = {
    start, price, bars, tick: 0, ou: 0,
    total: Math.max(1, bars * TICKS - S.tickInCandle),
    style: $('#inStyle').value,
    sigma: perCandleSigma() * 2 + dist * 0.06
  };
  const pct = (price / start - 1) * 100;
  $('#targetInfo').className = 'hint on';
  $('#targetInfo').textContent = 'Цель: ' + fmt(price) + (price >= start ? ' ↑' : ' ↓') +
    ' (' + fmtSigned(pct) + '%) за ' + bars + ' свечей.';
  toast('Цель задана: ' + fmt(price));
}

function finishTarget() {
  const p = lastPrice();
  const spread = Math.abs(S.high - S.low) * 0.35;
  S.band = { lo: p - spread, hi: p + spread };
  S.target = null;
  $('#targetInfo').className = 'hint';
  $('#targetInfo').textContent = 'Цель достигнута. График снова ходит свободно.';
  toast('Цель достигнута: ' + fmt(p), 'green');
}

function clearTarget() {
  S.target = null;
  $('#targetInfo').className = 'hint';
  $('#targetInfo').textContent = 'Цель не задана — график ходит внутри диапазона.';
}

/* ══════════ Позиция ══════════ */

function lastPrice() { const c = S.candles[S.candles.length - 1]; return c ? c.c : 0; }
function pnlAt(price, P) {
  P = P || S.position;
  if (!P) return 0;
  return (price - P.entry) * P.qty * (P.side === 'long' ? 1 : -1);
}

function openPosition(side) {
  const margin = Math.max(1, num('#inMargin') || 100);
  const lev = clamp(Math.round(num('#inLev') || 1), 1, 125);
  const entry = lastPrice();
  const qty = margin * lev / entry;

  let tp = num('#inTp');
  if (!isFinite(tp) || tp <= 0) tp = 0;
  else if ((side === 'long' && tp <= entry) || (side === 'short' && tp >= entry)) {
    toast('Тейк-профит не с той стороны от входа — не поставлен', 'red');
    tp = 0;
  }

  S.position = {
    side, entry, qty, margin, lev, tp,
    notional: margin * lev,
    liq: side === 'long' ? entry * (1 - 1 / lev) : entry * (1 + 1 / lev),
  };
  renderPosition();
  toast((side === 'long' ? 'Long' : 'Short') + ' по ' + fmt(entry), side === 'long' ? 'green' : 'red');
}

function closePosition(reason) {
  const P = S.position;
  if (!P) return;
  const exit = reason === 'tp' ? P.tp : reason === 'liq' ? P.liq : lastPrice();
  const pnl = reason === 'liq' ? -P.margin : pnlAt(exit, P);
  S.position = null;
  $('#posCard').classList.add('hidden');
  $('#abClose').classList.add('hidden');

  if (reason === 'tp') showNote('Тейк-профит исполнен', P, exit, pnl, false);
  else if (reason === 'liq') showNote('Позиция ликвидирована', P, exit, pnl, true);
  else toast('Закрыто: ' + fmtSigned(pnl) + ' USDT', pnl >= 0 ? 'green' : 'red');
}

function checkExits(price) {
  const P = S.position;
  if (!P) return;
  if (P.tp && ((P.side === 'long' && price >= P.tp) || (P.side === 'short' && price <= P.tp))) {
    closePosition('tp');
    return;
  }
  if (S.useLiq && ((P.side === 'long' && price <= P.liq) || (P.side === 'short' && price >= P.liq))) {
    closePosition('liq');
  }
}

function renderPosition() {
  const P = S.position;
  const card = $('#posCard');
  if (!P) { card.classList.add('hidden'); $('#abClose').classList.add('hidden'); return; }
  card.classList.toggle('hidden', !S.showPosCard);
  card.classList.toggle('compact', !S.showPosDetails);
  $('#abClose').classList.remove('hidden');

  const pnl = pnlAt(lastPrice(), P);
  const roe = pnl / P.margin * 100;
  const cls = pnl >= 0 ? 'green' : 'red';

  $('#pcSide').textContent = P.side === 'long' ? 'LONG' : 'SHORT';
  $('#pcSide').className = 'pc-side' + (P.side === 'short' ? ' short' : '');
  $('#pcLev').textContent = P.lev + 'x';
  $('#pcPnl').textContent = fmtSigned(pnl);
  $('#pcPnl').className = 'pc-pnl ' + cls;
  $('#pcRoe').textContent = fmtSigned(roe) + '%';
  $('#pcRoe').className = 'pc-roe ' + cls;
  $('#pcEntry').textContent = fmt(P.entry);
  $('#pcTp').textContent = P.tp ? fmt(P.tp) : 'нет';
  $('#pcSize').textContent = fmt(P.notional, 0);
  $('#pcLiq').textContent = S.useLiq ? fmt(P.liq) : 'выкл';
  $('#abPnl').textContent = fmtSigned(pnl);
  $('#abPnl').className = cls;
}

/* ══════════ Всплывающее окно ══════════ */

let noteTimer = null;
function showNote(title, P, exit, pnl, loss) {
  $('#noteIcon').textContent = loss ? '!' : '✓';
  $('#noteTitle').textContent = title;
  $('#noteSub').textContent = S.symbol + ' · ' + (P.side === 'long' ? 'LONG' : 'SHORT') +
    ' ' + P.lev + 'x · выход ' + fmt(exit);
  $('#notePnl').textContent = fmtSigned(pnl);
  $('#notePnl').className = 'note-pnl ' + (pnl >= 0 ? 'green' : 'red');
  $('#note').classList.toggle('loss', !!loss);
  $('#note').classList.add('on');
  wrap.classList.add('noted');
  // тост убираем, чтобы не наезжал на уведомление
  clearTimeout(toastTimer);
  $('#toast').classList.remove('show');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(hideNote, 6000);
}
function hideNote() {
  clearTimeout(noteTimer);
  $('#note').classList.remove('on');
  wrap.classList.remove('noted');
}

let toastTimer = null;
function toast(text, color) {
  const el = $('#toast');
  el.textContent = text;
  el.style.color = color === 'green' ? '#26a69a' : color === 'red' ? '#ef5350' : '#d1d4dc';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ══════════ Тик движка ══════════ */

function tick() {
  const c = S.candles[S.candles.length - 1];
  if (!c) return;
  let p;

  if (S.target) {
    const T = S.target;
    T.tick++;
    const prog = clamp(T.tick / T.total, 0, 1);
    // затухающий к нулю шум: последняя свеча закрывается ровно в цели
    const amp = T.sigma * Math.sin(Math.PI * prog);
    T.ou = T.ou * 0.86 + gauss() * amp * 0.51;
    p = T.tick >= T.total ? T.price : pathValue(T, prog) + T.ou;
  } else {
    p = freeStep(c.c);
  }

  p = Math.max(limitInCandle(p, c.h, c.l), 1e-9);
  c.c = p;
  if (p > c.h) c.h = p;
  if (p < c.l) c.l = p;
  c.v += S.volUnit * (0.35 + Math.abs(gauss()) * 0.9);

  S.tickInCandle++;
  if (S.tickInCandle >= TICKS) {
    S.tickInCandle = 0;
    S.candles.push({ t: c.t + S.tfMs, o: p, h: p, l: p, c: p, v: 0 });
    if (S.candles.length > 3000) S.candles.shift();
    if (S.target && S.target.tick >= S.target.total) finishTarget();
  }
  checkExits(p);
}

/* ══════════ Отрисовка ══════════ */

const cv = $('#chart');
const ctx = cv.getContext('2d');
const wrap = $('#chartWrap');
let W = 0, H = 0, narrow = false;
let AXIS_W = 74, TIME_H = 26, FS = 11, RIGHT_BARS = 8;

const C = {
  bg: '#131722', grid: '#1e222d', border: '#2a2e39', dim: '#787b86',
  green: '#26a69a', red: '#ef5350', blue: '#2962ff', tp: '#26a69a',
  volUp: 'rgba(38,166,154,.42)', volDn: 'rgba(239,83,80,.42)',
};

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = wrap.getBoundingClientRect();
  W = Math.max(80, r.width); H = Math.max(80, r.height);
  narrow = W < 560;
  TIME_H = narrow ? 22 : 26;
  FS = narrow ? 11 : 11;
  RIGHT_BARS = narrow ? 5 : 8;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function niceStep(range, lines) {
  const raw = range / lines;
  if (raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function tag(x, y, text, bg, color) {
  ctx.font = '600 ' + FS + 'px ' + MONO;
  const w = Math.min(ctx.measureText(text).width + 12, W - x - 1);
  ctx.fillStyle = bg;
  roundRect(x, y - 9, w, 18, 3);
  ctx.fill();
  ctx.fillStyle = color || '#fff';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6, y + 0.5);
}
function hline(y, color, dash, toX) {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(toX, y + 0.5); ctx.stroke();
  ctx.restore();
}

let lastDomUpdate = -1e9;

function draw(ts) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  const n = S.candles.length;
  if (!n) return;

  // ширина ценовой шкалы подстраивается под длину подписи
  ctx.font = FS + 'px ' + MONO;
  const wide = Math.max(Math.abs(S.scale.max), Math.abs(S.scale.min)) || lastPrice();
  AXIS_W = clamp(Math.ceil(ctx.measureText(fmt(wide)).width) + 16, 50, 104);

  const plotW = W - AXIS_W;
  const plotH = H - TIME_H;
  const volH = plotH * 0.16;
  const top = narrow ? 10 : 14;
  const bot = plotH - volH - 8;
  if (plotW < 20 || bot <= top) return;
  S.plotW = plotW; S.plotH = plotH;

  if (S.autoScroll) S.scrollRight = n - 1 + RIGHT_BARS;
  const view = plotW / S.barSpacing;
  const first = clamp(Math.floor(S.scrollRight - view), 0, n - 1);
  const last = clamp(Math.ceil(S.scrollRight), 0, n - 1);
  const X = (i) => plotW - (S.scrollRight - i) * S.barSpacing;

  // ── ценовая шкала
  let mn = Infinity, mx = -Infinity;
  for (let i = first; i <= last; i++) {
    const c = S.candles[i];
    if (c.l < mn) mn = c.l;
    if (c.h > mx) mx = c.h;
  }
  const P = S.position;
  if (P) { mn = Math.min(mn, P.entry); mx = Math.max(mx, P.entry); }
  if (P && P.tp) { mn = Math.min(mn, P.tp); mx = Math.max(mx, P.tp); }
  if (S.target && S.showTarget) { mn = Math.min(mn, S.target.price); mx = Math.max(mx, S.target.price); }
  if (!isFinite(mn) || !isFinite(mx) || mx - mn <= 0) { mn = lastPrice() * 0.995; mx = lastPrice() * 1.005; }
  const pad = (mx - mn) * 0.1;
  mn -= pad; mx += pad;

  // вертикальный масштаб: тянем шкалу цен справа
  const midP = (mn + mx) / 2, halfP = (mx - mn) / 2 / S.vZoom;
  mn = midP - halfP; mx = midP + halfP;

  const k = S.axisDrag ? 0.5 : 0.14;
  if (!S.scale.ready) { S.scale.min = mn; S.scale.max = mx; S.scale.ready = true; }
  else { S.scale.min = lerp(S.scale.min, mn, k); S.scale.max = lerp(S.scale.max, mx, k); }
  const pmin = S.scale.min, pmax = S.scale.max;
  const span = Math.max(pmax - pmin, 1e-12);
  const Y = (p) => bot - (p - pmin) / span * (bot - top);
  const priceAt = (y) => pmin + (bot - y) / (bot - top) * span;

  // ── тикер бледным фоном (по желанию)
  if (S.watermark) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 ' + Math.min(74, plotW / 6.5) + 'px ' + UI_FONT;
    ctx.fillText(S.symbol, plotW / 2, plotH / 2);
    ctx.restore();
  }

  // ── сетка
  ctx.lineWidth = 1;
  ctx.font = FS + 'px ' + MONO;
  ctx.textBaseline = 'middle';
  const step = niceStep(span, clamp(Math.round((bot - top) / 58), 2, 12));
  for (let p = Math.ceil(pmin / step) * step; p <= pmax; p += step) {
    const y = Math.round(Y(p)) + 0.5;
    if (y < 0 || y > plotH) continue;
    ctx.strokeStyle = C.grid;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    ctx.fillStyle = C.dim; ctx.textAlign = 'left';
    ctx.fillText(fmt(p), plotW + 8, y);
  }
  const stepBars = Math.max(1, Math.ceil((narrow ? 74 : 92) / S.barSpacing));
  ctx.textAlign = 'center';
  for (let i = first; i <= last; i++) {
    if (i % stepBars !== 0) continue;
    const x = Math.round(X(i)) + 0.5;
    if (x < 0 || x > plotW) continue;
    ctx.strokeStyle = C.grid;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
    ctx.fillStyle = C.dim;
    ctx.fillText(fmtTime(S.candles[i].t, S.tfMs), x, plotH + TIME_H / 2);
  }

  // ── объёмы
  let vmax = 0;
  for (let i = first; i <= last; i++) vmax = Math.max(vmax, S.candles[i].v);
  vmax = vmax || 1;
  const bw = Math.max(1, Math.floor(S.barSpacing * 0.72));
  for (let i = first; i <= last; i++) {
    const c = S.candles[i];
    const h = Math.max(1, c.v / vmax * volH);
    ctx.fillStyle = c.c >= c.o ? C.volUp : C.volDn;
    ctx.fillRect(Math.round(X(i) - bw / 2), plotH - 6 - h, bw, h);
  }

  // ── свечи
  for (let i = first; i <= last; i++) {
    const c = S.candles[i];
    const col = c.c >= c.o ? C.green : C.red;
    const cx = X(i);
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, Y(c.h));
    ctx.lineTo(Math.round(cx) + 0.5, Y(c.l));
    ctx.stroke();
    const yo = Y(c.o), yc = Y(c.c);
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(cx - bw / 2), Math.round(Math.min(yo, yc)),
      bw, Math.max(1, Math.round(Math.abs(yc - yo))));
  }

  // ── линия цели
  if (S.target && S.showTarget) {
    const y = Y(S.target.price);
    if (y > -20 && y < plotH + 20) {
      hline(y, '#f0b90b', [5, 4], plotW);
      tag(plotW + 1, y, fmt(S.target.price), '#f0b90b', '#131722');
      ctx.fillStyle = '#f0b90b';
      ctx.font = '600 ' + FS + 'px ' + UI_FONT;
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText('цель · осталось ' + Math.max(0, S.target.bars - Math.floor(S.target.tick / TICKS)), 8, y - 4);
      ctx.textBaseline = 'middle';
    }
  }

  // ── позиция
  if (P) {
    const y = Y(P.entry);
    hline(y, C.blue, [4, 3], plotW);
    tag(plotW + 1, y, fmt(P.entry), C.blue, '#fff');

    if (S.showPosLabel) {
      const pnl = pnlAt(lastPrice(), P);
      ctx.font = '700 ' + FS + 'px ' + MONO;
      const label = (P.side === 'long' ? 'LONG ' : 'SHORT ') + fmtSigned(pnl);
      const tw = ctx.measureText(label).width + 14;
      ctx.fillStyle = pnl >= 0 ? C.green : C.red;
      roundRect(8, y - 10, tw, 20, 3); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, 15, y + 0.5);
    }

    if (P.tp) {
      const yt = Y(P.tp);
      if (yt > -10 && yt < plotH + 10) {
        hline(yt, C.tp, [6, 3], plotW);
        tag(plotW + 1, yt, fmt(P.tp), C.tp, '#fff');
        ctx.fillStyle = C.tp;
        ctx.font = '700 ' + FS + 'px ' + UI_FONT;
        ctx.textBaseline = 'bottom';
        ctx.fillText('TP', 10, yt - 4);
        ctx.textBaseline = 'middle';
      }
    }
    if (S.useLiq) {
      const yl = Y(P.liq);
      if (yl > -10 && yl < plotH + 10) {
        hline(yl, 'rgba(239,83,80,.75)', [2, 4], plotW);
        tag(plotW + 1, yl, fmt(P.liq), '#7a2c2c', '#ffdede');
      }
    }
  }

  // ── текущая цена
  const lc = S.candles[n - 1];
  const up = lc.c >= lc.o;
  const ly = Y(lc.c);
  hline(ly, up ? C.green : C.red, [2, 3], plotW);
  tag(plotW + 1, ly, fmt(lc.c), up ? C.green : C.red, '#fff');

  // ── рамки осей
  ctx.strokeStyle = C.border;
  ctx.beginPath();
  ctx.moveTo(plotW + 0.5, 0); ctx.lineTo(plotW + 0.5, H);
  ctx.moveTo(0, plotH + 0.5); ctx.lineTo(W, plotH + 0.5);
  ctx.stroke();

  // ── прицел
  if (S.cross && S.cross.x < plotW && S.cross.y < plotH) {
    const { x, y } = S.cross;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#758696';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(plotW, Math.round(y) + 0.5);
    ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, plotH);
    ctx.stroke();
    ctx.restore();
    tag(plotW + 1, y, fmt(priceAt(y)), '#363a45', '#fff');

    const idx = Math.round(S.scrollRight - (plotW - x) / S.barSpacing);
    const base = S.candles[clamp(idx, 0, n - 1)].t;
    const txt = fmtTime(base + (idx > n - 1 ? (idx - n + 1) * S.tfMs : 0), S.tfMs);
    ctx.font = '600 ' + FS + 'px ' + MONO;
    const tw = ctx.measureText(txt).width + 12;
    ctx.fillStyle = '#363a45';
    roundRect(clamp(x - tw / 2, 0, plotW - tw), plotH + 2, tw, TIME_H - 4, 3); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
    ctx.fillText(txt, clamp(x, tw / 2, plotW - tw / 2), plotH + TIME_H / 2);
  }

  if (ts - lastDomUpdate > 80) {
    lastDomUpdate = ts;
    $('#posCard').style.right = (AXIS_W + 4) + 'px';
    updateLegend();
    renderPosition();
  }
}

function updateLegend() {
  const n = S.candles.length;
  let idx = n - 1;
  if (S.cross) idx = clamp(Math.round(S.scrollRight - (W - AXIS_W - S.cross.x) / S.barSpacing), 0, n - 1);
  const c = S.candles[idx];
  const prev = S.candles[Math.max(0, idx - 1)];
  const diff = c.c - prev.c;
  const pct = prev.c ? diff / prev.c * 100 : 0;
  const col = c.c >= c.o ? '#26a69a' : '#ef5350';

  $('#lgSym').textContent = S.symbol;
  $('#lgTf').textContent = TF_RU[S.tf];
  const chg = $('#lgChg');
  chg.textContent = fmtSigned(diff, DEC) + ' (' + fmtSigned(pct) + '%)';
  chg.style.color = diff >= 0 ? '#26a69a' : '#ef5350';

  // на телефоне карточка позиции занимает правый угол — освобождаем строку OHLC
  const cardUp = S.position && S.showPosCard;
  $('#lgOhlc').innerHTML = !S.showOhlc ? '' : narrow
    ? (cardUp ? '' :
      `<span style="color:${col}">О<b> ${fmt(c.o)}</b>&nbsp; М<b> ${fmt(c.h)}</b>&nbsp; ` +
      `Н<b> ${fmt(c.l)}</b>&nbsp; З<b> ${fmt(c.c)}</b></span>`)
    : `<span style="color:${col}">O<b> ${fmt(c.o)}</b>&nbsp; H<b> ${fmt(c.h)}</b>&nbsp; ` +
      `L<b> ${fmt(c.l)}</b>&nbsp; C<b> ${fmt(c.c)}</b></span>` +
      `<span style="color:#787b86">&nbsp; Vol <b>${fmtVol(c.v)}</b></span>`;

  $('#tbSymbol').textContent = S.symbol;
  document.title = fmt(lastPrice()) + ' · ' + S.symbol;
}

/* ══════════ Цикл ══════════ */

let prevT = performance.now(), acc = 0;
function frame(now) {
  const dt = clamp(now - prevT, 0, 120);
  prevT = now;

  if (S.count) {
    const left = Math.ceil((S.count.until - now) / 1000);
    if (left <= 0) { hideCountdown(); setRunning(true); }
    else if (left !== S.count.shown) {
      S.count.shown = left;
      const el = $('#countdown');
      el.textContent = String(left);
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    }
  }

  if (S.running) {
    acc += dt;
    const tickMs = S.candleMs / TICKS;
    let guard = 0;
    while (acc >= tickMs && guard < 400) { acc -= tickMs; tick(); guard++; }
  }
  draw(now);
  requestAnimationFrame(frame);
}

/* ══════════ Управление ══════════ */

function setRunning(v) {
  S.running = v;
  if (v) { S.autoScroll = true; acc = 0; }
  $('#btnPlay').textContent = v ? '❚❚ Пауза' : '▶ Старт';
  $('#btnPlay').classList.toggle('primary', !v);
  $('#abPlay').textContent = v ? '❚❚' : '▶';
}
function hideCountdown() {
  S.count = null;
  $('#countdown').classList.remove('on', 'pop');
}
function togglePlay() {
  if (S.count) { hideCountdown(); return; }
  if (S.running) { setRunning(false); return; }
  if ($('#inCountdown').checked) {
    S.count = { until: performance.now() + 3000, shown: 0 };
    $('#countdown').classList.add('on');
  } else setRunning(true);
}

function applyInputs(regen, anchor) {
  S.symbol = ($('#inSymbol').value || 'TICKER').toUpperCase().trim();
  const lo = num('#inLow'), hi = num('#inHigh');
  if (isFinite(lo) && isFinite(hi) && lo !== hi) { S.low = Math.min(lo, hi); S.high = Math.max(lo, hi); }
  S.volMult = num('#inVol');
  const mc = num('#inMaxCandle');
  S.maxCandle = isFinite(mc) && mc > 0 ? mc : 0;
  $('#outMaxC').textContent = S.maxCandle
    ? (S.maxCandle / ((S.low + S.high) / 2) * 100).toFixed(2) + '% от цены'
    : 'без ограничения';
  if (regen) { genHistory(anchor); clearTarget(); }
  else S.sigmaTick = sigmaFor();
}

function syncZoom() {
  $('#inZoom').value = String(Math.round(S.barSpacing));
  $('#outZoom').textContent = Math.round(S.barSpacing) + ' px';
}
function openSheet(v) {
  $('#sidebar').classList.toggle('open', v);
  $('#backdrop').classList.toggle('on', v);
}

/* ── Тач-жесты ── */
const dist2 = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
let tch = null, holdTimer = null;

// куда попал палец или курсор: тело графика, шкала цен справа, шкала времени снизу
function regionAt(x, y) {
  if (x > S.plotW) return 'price';
  if (y > S.plotH) return 'time';
  return 'chart';
}
function setVZoom(z) { S.vZoom = clamp(z, 0.15, 12); }
function setSpacing(b) { S.barSpacing = clamp(b, 2, 26); syncZoom(); }

function touchStart(e) {
  const r = cv.getBoundingClientRect();
  if (e.touches.length === 2) {
    clearTimeout(holdTimer);
    const dx = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
    const dy = Math.abs(e.touches[0].clientY - e.touches[1].clientY);
    // щипок вдоль экрана растягивает время, поперёк — цену
    tch = { mode: 'pinch', vert: dy > dx, d0: dist2(e.touches) || 1, bs0: S.barSpacing, z0: S.vZoom };
    S.axisDrag = { kind: 't' };
    return;
  }
  const t = e.touches[0];
  const x = t.clientX - r.left, y = t.clientY - r.top;
  const reg = regionAt(x, y);
  clearTimeout(holdTimer);

  if (reg === 'price') { tch = { mode: 'vscale', y0: y, z0: S.vZoom }; S.axisDrag = { kind: 'v' }; return; }
  if (reg === 'time') { tch = { mode: 'hscale', x0: x, b0: S.barSpacing }; S.axisDrag = { kind: 'h' }; return; }

  tch = { mode: 'tap', x0: x, y0: y, right0: S.scrollRight, t0: performance.now() };
  holdTimer = setTimeout(() => {
    if (tch && tch.mode === 'tap') { tch.mode = 'cross'; S.cross = { x: tch.x0, y: tch.y0 }; }
  }, 320);
}
function touchMove(e) {
  if (!tch) return;
  const r = cv.getBoundingClientRect();
  if (tch.mode === 'pinch') {
    if (e.touches.length < 2) return;
    const k = dist2(e.touches) / tch.d0;
    if (tch.vert) setVZoom(tch.z0 * k); else setSpacing(tch.bs0 * k);
    return;
  }
  const t = e.touches[0];
  const x = t.clientX - r.left, y = t.clientY - r.top;
  if (tch.mode === 'vscale') { setVZoom(tch.z0 * Math.exp(-(y - tch.y0) * 0.006)); return; }
  if (tch.mode === 'hscale') { setSpacing(tch.b0 * Math.exp((x - tch.x0) * 0.005)); return; }
  if (tch.mode === 'cross') { S.cross = { x, y }; return; }
  if (tch.mode === 'tap' && Math.hypot(x - tch.x0, y - tch.y0) > 9) {
    tch.mode = 'pan';
    clearTimeout(holdTimer);
  }
  if (tch.mode === 'pan') {
    S.autoScroll = false;
    S.scrollRight = clamp(tch.right0 - (x - tch.x0) / S.barSpacing, 4, S.candles.length + 200);
  }
}
function touchEnd() {
  clearTimeout(holdTimer);
  S.axisDrag = null;
  if (tch && tch.mode === 'tap' && performance.now() - tch.t0 < 300) {
    // в чистом режиме график запускается касанием
    if (document.body.classList.contains('clean')) togglePlay();
  }
  S.cross = null;
  tch = null;
}

/* ── Привязки ── */
function bind() {
  document.querySelectorAll('.tf').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tf').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      S.tf = b.dataset.tf;
      S.tfMs = TF_MS[S.tf];
      applyInputs(true, lastPrice());
      b.blur();
    });
  });
  $('.tf[data-tf="15m"]').classList.add('on');

  $('#btnPlay').addEventListener('click', function () { togglePlay(); this.blur(); });
  $('#abPlay').addEventListener('click', togglePlay);
  $('#btnMenu').addEventListener('click', () => openSheet(true));
  $('#btnSheetClose').addEventListener('click', () => openSheet(false));
  $('#backdrop').addEventListener('click', () => openSheet(false));

  $('#btnClean').addEventListener('click', function () {
    $('#inClean').checked = !$('#inClean').checked;
    $('#inClean').dispatchEvent(new Event('change'));
    this.blur();
  });
  $('#btnFrame').addEventListener('click', function () {
    document.body.classList.toggle('frame');
    this.classList.toggle('on', document.body.classList.contains('frame'));
    this.blur();
    setTimeout(resize, 40);
  });

  $('#btnRegen').addEventListener('click', function () { applyInputs(true); toast('Новая история'); this.blur(); });
  ['#inSymbol', '#inLow', '#inHigh', '#inStart', '#inMaxCandle'].forEach((s) =>
    $(s).addEventListener('change', () => applyInputs(true)));

  $('#inVol').addEventListener('input', function () {
    $('#outVol').textContent = parseFloat(this.value).toFixed(1) + '×';
    applyInputs(false);
  });
  $('#inSpeed').addEventListener('input', function () {
    S.candleMs = parseFloat(this.value) * 1000;
    $('#outSpeed').textContent = parseFloat(this.value).toFixed(1) + ' с';
  });
  $('#inZoom').addEventListener('input', function () {
    S.barSpacing = parseFloat(this.value);
    $('#outZoom').textContent = this.value + ' px';
  });

  $('#btnTarget').addEventListener('click', setTarget);
  $('#btnClearTarget').addEventListener('click', () => { clearTarget(); toast('Цель сброшена'); });
  $('#inShowTarget').addEventListener('change', function () { S.showTarget = this.checked; });
  document.querySelectorAll('#quickPct button').forEach((b) => {
    b.addEventListener('click', () => {
      $('#inTarget').value = (lastPrice() * (1 + parseFloat(b.dataset.pct) / 100)).toFixed(DEC);
    });
  });

  // тейк-профит: проценты от маржи с учётом плеча
  document.querySelectorAll('#quickTp button').forEach((b) => {
    b.addEventListener('click', () => {
      const roe = parseFloat(b.dataset.tp) / 100;
      const P = S.position;
      const entry = P ? P.entry : lastPrice();
      const margin = P ? P.margin : Math.max(1, num('#inMargin') || 100);
      const lev = P ? P.lev : clamp(Math.round(num('#inLev') || 1), 1, 125);
      const qty = P ? P.qty : margin * lev / entry;
      const side = P ? P.side : 'long';
      const move = roe * margin / qty * (side === 'long' ? 1 : -1);
      $('#inTp').value = (entry + move).toFixed(DEC);
      if (P) { P.tp = entry + move; }
    });
  });
  $('#inTp').addEventListener('change', function () {
    const P = S.position;
    if (!P) return;
    const tp = parseFloat(this.value);
    if (!isFinite(tp) || tp <= 0) { P.tp = 0; return; }
    if ((P.side === 'long' && tp <= P.entry) || (P.side === 'short' && tp >= P.entry)) {
      toast('Тейк-профит не с той стороны от входа', 'red');
      return;
    }
    P.tp = tp;
  });

  $('#btnLong').addEventListener('click', () => openPosition('long'));
  $('#btnShort').addEventListener('click', () => openPosition('short'));
  $('#btnClose').addEventListener('click', () => closePosition());
  $('#abLong').addEventListener('click', () => openPosition('long'));
  $('#abShort').addEventListener('click', () => openPosition('short'));
  $('#abClose').addEventListener('click', () => closePosition());
  $('#noteX').addEventListener('click', hideNote);

  $('#inLiq').addEventListener('change', function () { S.useLiq = this.checked; });
  $('#inWatermark').addEventListener('change', function () { S.watermark = this.checked; });
  $('#inShowCard').addEventListener('change', function () { S.showPosCard = this.checked; });
  $('#inShowDetails').addEventListener('change', function () { S.showPosDetails = this.checked; });
  $('#inShowLabel').addEventListener('change', function () { S.showPosLabel = this.checked; });
  $('#inShowOhlc').addEventListener('change', function () { S.showOhlc = this.checked; });
  $('#inTradeBar').addEventListener('change', function () {
    document.body.classList.toggle('no-trade-bar', !this.checked);
    setTimeout(resize, 40);
  });
  $('#inClean').addEventListener('change', function () {
    document.body.classList.toggle('clean', this.checked);
    $('#btnClean').classList.toggle('on', this.checked);
    if (this.checked) openSheet(false);
    setTimeout(resize, 40);
  });

  // мышь
  wrap.addEventListener('mousemove', (e) => {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const A = S.axisDrag;
    if (A && A.kind === 'v') { S.cross = null; setVZoom(A.z0 * Math.exp(-(y - A.y0) * 0.006)); return; }
    if (A && A.kind === 'h') { S.cross = null; setSpacing(A.b0 * Math.exp((x - A.x0) * 0.005)); return; }

    const reg = regionAt(x, y);
    wrap.style.cursor = reg === 'price' ? 'ns-resize' : reg === 'time' ? 'ew-resize' : 'crosshair';
    S.cross = { x, y };
    if (S.drag) {
      S.autoScroll = false;
      S.scrollRight = clamp(S.drag.right - (x - S.drag.x) / S.barSpacing, 4, S.candles.length + 200);
    }
  });
  wrap.addEventListener('mouseleave', () => { S.cross = null; S.drag = null; });
  wrap.addEventListener('mousedown', (e) => {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const reg = regionAt(x, y);
    if (reg === 'price') S.axisDrag = { kind: 'v', y0: y, z0: S.vZoom };
    else if (reg === 'time') S.axisDrag = { kind: 'h', x0: x, b0: S.barSpacing };
    else S.drag = { x, right: S.scrollRight };
  });
  window.addEventListener('mouseup', () => { S.drag = null; S.axisDrag = null; });
  wrap.addEventListener('dblclick', (e) => {
    const r = cv.getBoundingClientRect();
    const reg = regionAt(e.clientX - r.left, e.clientY - r.top);
    if (reg === 'price') { setVZoom(1); toast('Масштаб цены сброшен'); }
    else if (reg === 'time') setSpacing(7);
    else S.autoScroll = true;
  });
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const up = e.deltaY < 0;
    // колесо над шкалой цен растягивает график по вертикали
    if (regionAt(e.clientX - r.left, e.clientY - r.top) === 'price') setVZoom(S.vZoom * (up ? 1.08 : 0.92));
    else setSpacing(S.barSpacing * (up ? 1.1 : 0.9));
  }, { passive: false });

  // тач
  wrap.addEventListener('touchstart', touchStart, { passive: true });
  wrap.addEventListener('touchmove', touchMove, { passive: true });
  wrap.addEventListener('touchend', touchEnd, { passive: true });
  wrap.addEventListener('touchcancel', touchEnd, { passive: true });

  // свайп вниз по шапке листа настроек закрывает его
  const head = $('.sheet-head');
  let sy = null;
  head.addEventListener('touchstart', (e) => { sy = e.touches[0].clientY; }, { passive: true });
  head.addEventListener('touchmove', (e) => {
    if (sy === null) return;
    const dy = e.touches[0].clientY - sy;
    if (dy > 0) $('#sidebar').style.transform = 'translateY(' + dy + 'px)';
  }, { passive: true });
  head.addEventListener('touchend', (e) => {
    const dy = e.changedTouches[0].clientY - (sy || 0);
    $('#sidebar').style.transform = '';
    if (dy > 70) openSheet(false);
    sy = null;
  }, { passive: true });

  // клавиши
  window.addEventListener('keydown', (e) => {
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (k === 'escape') { hideNote(); openSheet(false); }
    else if (k === 'b' || k === 'и') openPosition('long');
    else if (k === 's' || k === 'ы') openPosition('short');
    else if (k === 'c' || k === 'с') closePosition();
    else if (k === 'h' || k === 'р') $('#btnClean').click();
    else if (k === 'v' || k === 'м') $('#btnFrame').click();
    else if (k === 'r' || k === 'к') $('#btnRegen').click();
    else if (k === 't' || k === 'е') setTarget();
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 250));
  if (window.ResizeObserver) new ResizeObserver(resize).observe(wrap);
}

/* ══════════ Старт ══════════ */

function init() {
  bind();
  S.candleMs = num('#inSpeed') * 1000;
  S.barSpacing = num('#inZoom');
  S.useLiq = $('#inLiq').checked;
  S.watermark = $('#inWatermark').checked;
  S.showTarget = $('#inShowTarget').checked;
  S.showPosCard = $('#inShowCard').checked;
  S.showPosDetails = $('#inShowDetails').checked;
  S.showPosLabel = $('#inShowLabel').checked;
  S.showOhlc = $('#inShowOhlc').checked;
  document.body.classList.toggle('no-trade-bar', !$('#inTradeBar').checked);
  applyInputs(true);
  clearTarget();
  resize();
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();

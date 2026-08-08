'use strict';
/* Chart Studio — симулятор торгового графика для записи видео.
   Никаких внешних библиотек: только canvas. */

(function () {

/* ══════════ Утилиты ══════════ */

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

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
  const s = v >= 0 ? '+' : '−';
  return s + fmt(Math.abs(v), d === undefined ? 2 : d);
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

const HISTORY = 300;      // сколько свечей истории генерируем
const RIGHT_BARS = 8;     // пустое место справа, как в TradingView
const TICKS = 45;         // тиков внутри одной свечи

const S = {
  symbol: 'BTCUSDT',
  tf: '15m',
  tfMs: TF_MS['15m'],
  low: 61000,
  high: 69000,
  volMult: 1,
  candles: [],
  running: false,
  candleMs: 1500,
  tickInCandle: 0,
  barSpacing: 8,
  scrollRight: 0,
  autoScroll: true,
  band: { lo: 61000, hi: 69000 },
  sigmaTick: 1,
  volUnit: 120,
  target: null,
  showTarget: false,
  useLiq: true,
  position: null,
  cross: null,
  scale: { min: 0, max: 1, ready: false },
  drag: null,
};

/* ══════════ Генерация ══════════ */

// Шаг цены за тик. Считается от диапазона, заданного пользователем,
// чтобы цена успевала обойти его целиком.
function sigmaFor() {
  return Math.abs(S.high - S.low) * 0.026 * S.volMult / Math.sqrt(TICKS);
}
function perCandleSigma() { return sigmaFor() * Math.sqrt(TICKS); }

function genHistory(anchor) {
  const lo = Math.min(S.low, S.high), hi = Math.max(S.low, S.high);
  S.band = { lo, hi };
  S.sigmaTick = sigmaFor();
  DEC = calcDec((lo + hi) / 2);
  S.volUnit = Math.max(1, (lo + hi) / 2 * 0.0004);

  const mid = (lo + hi) / 2;
  let p = mid + (rnd() - 0.5) * (hi - lo) * 0.5;
  const now = Date.now();
  const t0 = Math.floor(now / S.tfMs) * S.tfMs - (HISTORY - 1) * S.tfMs;

  const out = [];
  for (let i = 0; i < HISTORY; i++) {
    const o = p;
    let h = p, l = p;
    for (let k = 0; k < TICKS; k++) {
      p = freeStep(p);
      if (p > h) h = p;
      if (p < l) l = p;
    }
    out.push({
      t: t0 + i * S.tfMs, o, h, l, c: p,
      v: S.volUnit * TICKS * (0.4 + rnd() * 1.2) * (1 + Math.abs(p - o) / (hi - lo) * 4)
    });
  }

  // при желании подгоняем последнюю цену под заданную стартовую
  const typed = parseFloat($('#inStart').value);
  const wanted = isFinite(typed) && typed > 0 ? typed : anchor;
  if (isFinite(wanted) && wanted > 0) {
    const err = wanted - out[out.length - 1].c;
    for (let i = 0; i < out.length; i++) {
      const k = err * Math.pow(i / (out.length - 1), 1.6);
      const c = out[i];
      c.o += k; c.h += k; c.l += k; c.c += k;
    }
  }

  // если цена оказалась вне заданного диапазона (например, после цели),
  // коридор блуждания переезжает к ней, иначе следующий тик дёрнет график
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
  // упругий отбой от границ: рядом с краем — обычное отражение,
  // далеко за краем — плавный возврат, без скачков
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
    default: { // pullback
      const base = T.start + d * easeInOut(p);
      return base - d * 0.14 * Math.sin(2 * Math.PI * p * 1.5) * (1 - p);
    }
  }
}

function setTarget() {
  const price = parseFloat($('#inTarget').value);
  const bars = Math.round(parseFloat($('#inBars').value));
  if (!isFinite(price) || price <= 0) { toast('Укажи цену цели', 'red'); return; }
  if (!isFinite(bars) || bars < 1) { toast('Укажи количество свечей', 'red'); return; }

  const total = Math.max(1, bars * TICKS - S.tickInCandle);
  S.target = {
    start: lastPrice(), price, bars, total, tick: 0, ou: 0,
    style: $('#inStyle').value,
    sigma: perCandleSigma() * 2 + Math.abs(price - lastPrice()) * 0.06
  };
  const dir = price >= S.target.start ? '↑ вверх' : '↓ вниз';
  const pct = (price / S.target.start - 1) * 100;
  $('#targetInfo').className = 'hint on';
  $('#targetInfo').textContent = `Цель: ${fmt(price)} ${dir} (${fmtSigned(pct)}%) за ${bars} свечей.`;
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

function openPosition(side) {
  const margin = Math.max(1, parseFloat($('#inMargin').value) || 100);
  const lev = clamp(Math.round(parseFloat($('#inLev').value) || 1), 1, 125);
  const entry = lastPrice();
  const qty = margin * lev / entry;
  const liq = side === 'long' ? entry * (1 - 1 / lev) : entry * (1 + 1 / lev);
  S.position = { side, entry, qty, margin, lev, liq, notional: margin * lev };
  renderPosition();
  toast((side === 'long' ? 'Long' : 'Short') + ' открыт по ' + fmt(entry), side === 'long' ? 'green' : 'red');
}

function pnlOf(price) {
  const P = S.position;
  if (!P) return 0;
  return (price - P.entry) * P.qty * (P.side === 'long' ? 1 : -1);
}

function closePosition(reason) {
  if (!S.position) return;
  const p = lastPrice();
  const pnl = reason === 'liq' ? -S.position.margin : pnlOf(p);
  S.position = null;
  $('#posCard').classList.add('hidden');
  if (reason === 'liq') toast('ЛИКВИДАЦИЯ  ' + fmt(pnl) + ' USDT', 'red');
  else toast('Закрыто: ' + fmtSigned(pnl) + ' USDT', pnl >= 0 ? 'green' : 'red');
}

function checkLiq(price) {
  const P = S.position;
  if (!P || !S.useLiq) return;
  if ((P.side === 'long' && price <= P.liq) || (P.side === 'short' && price >= P.liq)) {
    closePosition('liq');
  }
}

function renderPosition() {
  const P = S.position;
  const card = $('#posCard');
  if (!P) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const price = lastPrice();
  const pnl = pnlOf(price);
  const roe = pnl / P.margin * 100;
  const up = pnl >= 0;

  $('#pcSide').textContent = P.side === 'long' ? 'LONG' : 'SHORT';
  $('#pcSide').className = 'pc-side' + (P.side === 'short' ? ' short' : '');
  $('#pcLev').textContent = P.lev + 'x';
  $('#pcSym').textContent = S.symbol;
  $('#pcPnl').textContent = fmtSigned(pnl) + ' USDT';
  $('#pcPnl').className = 'pc-pnl ' + (up ? 'green' : 'red');
  $('#pcRoe').textContent = fmtSigned(roe) + '%';
  $('#pcRoe').className = 'pc-roe ' + (up ? 'green' : 'red');
  $('#pcEntry').textContent = fmt(P.entry);
  $('#pcSize').textContent = fmt(P.notional, 0) + ' USDT';
  $('#pcMargin').textContent = fmt(P.margin, 0) + ' USDT';
  $('#pcLiq').textContent = fmt(P.liq);
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
    const base = pathValue(T, prog);
    // затухающий к нулю шум: в конце пути цена приходит ровно в цель
    const amp = T.sigma * Math.sin(Math.PI * prog);
    T.ou = T.ou * 0.86 + gauss() * amp * 0.51;
    p = base + T.ou;
    if (T.tick >= T.total) p = T.price;
  } else {
    p = freeStep(c.c);
  }

  p = Math.max(p, 1e-9);
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
  checkLiq(p);
}

/* ══════════ Отрисовка ══════════ */

const UI_FONT = '"Trebuchet MS",-apple-system,"Segoe UI",Roboto,Arial,sans-serif';
const cv = $('#chart');
const ctx = cv.getContext('2d');
const wrap = $('#chartWrap');
let W = 0, H = 0;

const AXIS_W = 74, TIME_H = 26, PAD_T = 14;
const C = {
  bg: '#131722', grid: '#1e222d', border: '#2a2e39', text: '#d1d4dc',
  dim: '#787b86', green: '#26a69a', red: '#ef5350', blue: '#2962ff',
  volUp: 'rgba(38,166,154,.42)', volDn: 'rgba(239,83,80,.42)',
};

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = wrap.getBoundingClientRect();
  W = Math.max(80, r.width); H = Math.max(80, r.height);
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function niceStep(range, lines) {
  const raw = range / lines;
  if (raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const s = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return s * mag;
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
  ctx.font = '600 11px ui-monospace,Menlo,Consolas,monospace';
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = bg;
  roundRect(x, y - 9, w, 18, 3);
  ctx.fill();
  ctx.fillStyle = color || '#fff';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6, y + 0.5);
}

function draw(ts) {
  const plotW = W - AXIS_W;
  const plotH = H - TIME_H;
  const volH = plotH * 0.16;
  const top = PAD_T;
  const bot = plotH - volH - 8;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  const n = S.candles.length;
  if (!n || plotW < 20) return;

  // ── видимая область
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
  if (S.position) { mn = Math.min(mn, S.position.entry); mx = Math.max(mx, S.position.entry); }
  if (S.target && S.showTarget) { mn = Math.min(mn, S.target.price); mx = Math.max(mx, S.target.price); }
  if (!isFinite(mn) || !isFinite(mx) || mx - mn <= 0) { mn = lastPrice() * 0.99; mx = lastPrice() * 1.01; }
  const pad = (mx - mn) * 0.1;
  mn -= pad; mx += pad;

  if (!S.scale.ready) { S.scale.min = mn; S.scale.max = mx; S.scale.ready = true; }
  else {
    S.scale.min = lerp(S.scale.min, mn, 0.14);
    S.scale.max = lerp(S.scale.max, mx, 0.14);
  }
  const pmin = S.scale.min, pmax = S.scale.max;
  const span = Math.max(pmax - pmin, 1e-12);
  const Y = (p) => bot - (p - pmin) / span * (bot - top);
  const P = (y) => pmin + (bot - y) / (bot - top) * span;

  // ── водяной знак
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '700 ' + Math.min(74, plotW / 7) + 'px ' + UI_FONT;
  ctx.fillText(S.symbol, plotW / 2, plotH / 2 - 16);
  ctx.font = '600 ' + Math.min(26, plotW / 18) + 'px ' + UI_FONT;
  ctx.fillText(TF_RU[S.tf] + ' · Chart Studio', plotW / 2, plotH / 2 + 26);
  ctx.restore();

  // ── сетка по цене
  const step = niceStep(span, clamp(Math.round((bot - top) / 58), 2, 12));
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  ctx.fillStyle = C.dim;
  ctx.font = '11px ui-monospace,Menlo,Consolas,monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const gStart = Math.ceil(pmin / step) * step;
  for (let p = gStart; p <= pmax; p += step) {
    const y = Math.round(Y(p)) + 0.5;
    if (y < 0 || y > plotH) continue;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    ctx.fillText(fmt(p), plotW + 8, y);
  }

  // ── сетка по времени
  const stepBars = Math.max(1, Math.ceil(92 / S.barSpacing));
  ctx.fillStyle = C.dim;
  ctx.textAlign = 'center';
  for (let i = first; i <= last; i++) {
    if (i % stepBars !== 0) continue;
    const x = Math.round(X(i)) + 0.5;
    if (x < 0 || x > plotW) continue;
    ctx.strokeStyle = C.grid;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
    ctx.fillText(fmtTime(S.candles[i].t, S.tfMs), x, plotH + 13);
  }

  // ── объёмы
  let vmax = 0;
  for (let i = first; i <= last; i++) vmax = Math.max(vmax, S.candles[i].v);
  vmax = vmax || 1;
  const bw = Math.max(1, Math.floor(S.barSpacing * 0.72));
  for (let i = first; i <= last; i++) {
    const c = S.candles[i];
    const x = Math.round(X(i) - bw / 2);
    const h = Math.max(1, c.v / vmax * volH);
    ctx.fillStyle = c.c >= c.o ? C.volUp : C.volDn;
    ctx.fillRect(x, plotH - 6 - h, bw, h);
  }

  // ── свечи
  for (let i = first; i <= last; i++) {
    const c = S.candles[i];
    const up = c.c >= c.o;
    const col = up ? C.green : C.red;
    const cx = X(i);
    const xw = Math.round(cx) + 0.5;
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xw, Y(c.h)); ctx.lineTo(xw, Y(c.l)); ctx.stroke();
    const yo = Y(c.o), yc = Y(c.c);
    const bt = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(cx - bw / 2), Math.round(bt), bw, Math.round(bh) || 1);
  }

  // ── линия цели
  if (S.target && S.showTarget) {
    const y = Y(S.target.price);
    if (y > -20 && y < plotH + 20) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#f0b90b'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(plotW, y + 0.5); ctx.stroke();
      ctx.restore();
      tag(plotW + 1, y, fmt(S.target.price), '#f0b90b', '#131722');
      const bl = S.target.bars - Math.floor(S.target.tick / TICKS);
      ctx.fillStyle = '#f0b90b';
      ctx.font = '600 11px ' + UI_FONT;
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText('цель · осталось свечей: ' + Math.max(0, bl), 8, y - 4);
    }
  }

  // ── позиция
  if (S.position) {
    const p = S.position;
    const y = Y(p.entry);
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = C.blue; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(plotW, y + 0.5); ctx.stroke();
    ctx.restore();
    tag(plotW + 1, y, fmt(p.entry), C.blue, '#fff');

    const pnl = pnlOf(lastPrice());
    ctx.font = '700 11px ui-monospace,Menlo,Consolas,monospace';
    const label = (p.side === 'long' ? 'LONG ' : 'SHORT ') + fmtSigned(pnl);
    const tw = ctx.measureText(label).width + 14;
    ctx.fillStyle = pnl >= 0 ? C.green : C.red;
    roundRect(8, y - 10, tw, 20, 3); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, 15, y + 0.5);

    if (S.useLiq) {
      const yl = Y(p.liq);
      if (yl > -10 && yl < plotH + 10) {
        ctx.save();
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = 'rgba(239,83,80,.75)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, yl + 0.5); ctx.lineTo(plotW, yl + 0.5); ctx.stroke();
        ctx.restore();
        tag(plotW + 1, yl, fmt(p.liq), '#7a2c2c', '#ffdede');
      }
    }
  }

  // ── текущая цена
  const lc = S.candles[n - 1];
  const lp = lc.c;
  const ly = Y(lp);
  const up = lc.c >= lc.o;
  ctx.save();
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = up ? C.green : C.red; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, ly + 0.5); ctx.lineTo(plotW, ly + 0.5); ctx.stroke();
  ctx.restore();
  tag(plotW + 1, ly, fmt(lp), up ? C.green : C.red, '#fff');

  // ── рамки осей
  ctx.strokeStyle = C.border; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotW + 0.5, 0); ctx.lineTo(plotW + 0.5, H);
  ctx.moveTo(0, plotH + 0.5); ctx.lineTo(W, plotH + 0.5);
  ctx.stroke();

  // ── прицел
  if (S.cross && S.cross.x < plotW && S.cross.y < plotH) {
    const { x, y } = S.cross;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#758696'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(plotW, Math.round(y) + 0.5);
    ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, plotH);
    ctx.stroke();
    ctx.restore();
    tag(plotW + 1, y, fmt(P(y)), '#363a45', '#fff');
    const idx = Math.round(S.scrollRight - (plotW - x) / S.barSpacing);
    const t = S.candles[clamp(idx, 0, n - 1)].t + (idx > n - 1 ? (idx - n + 1) * S.tfMs : 0);
    ctx.font = '600 11px ui-monospace,Menlo,Consolas,monospace';
    const txt = fmtTime(t, S.tfMs);
    const tw = ctx.measureText(txt).width + 12;
    ctx.fillStyle = '#363a45';
    roundRect(clamp(x - tw / 2, 0, plotW - tw), plotH + 2, tw, 18, 3); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, clamp(x, tw / 2, plotW - tw / 2), plotH + 11);
  }

  // текст в DOM обновляем ~12 раз в секунду, сам график — каждый кадр
  if (ts - lastDomUpdate > 80) {
    lastDomUpdate = ts;
    updateLegend();
    renderPosition();
  }
}

let lastDomUpdate = -1e9;

function updateLegend() {
  const n = S.candles.length;
  let idx = n - 1;
  if (S.cross) {
    const plotW = W - AXIS_W;
    const i = Math.round(S.scrollRight - (plotW - S.cross.x) / S.barSpacing);
    idx = clamp(i, 0, n - 1);
  }
  const c = S.candles[idx];
  const prev = S.candles[Math.max(0, idx - 1)];
  const diff = c.c - prev.c;
  const pct = prev.c ? diff / prev.c * 100 : 0;
  const col = c.c >= c.o ? '#26a69a' : '#ef5350';
  const dcol = diff >= 0 ? '#26a69a' : '#ef5350';

  $('#lgSym').textContent = S.symbol;
  $('#lgTf').textContent = TF_RU[S.tf];
  $('#lgOhlc').innerHTML =
    `<span style="color:${col}">O<b> ${fmt(c.o)}</b>&nbsp; H<b> ${fmt(c.h)}</b>&nbsp; ` +
    `L<b> ${fmt(c.l)}</b>&nbsp; C<b> ${fmt(c.c)}</b></span>` +
    `<span style="color:${dcol}">&nbsp; ${fmtSigned(diff, DEC)} (${fmtSigned(pct)}%)</span>` +
    `<span style="color:#787b86">&nbsp; Vol <b>${fmtVol(c.v)}</b></span>`;
  $('#tbSymbol').textContent = S.symbol;
  document.title = fmt(lastPrice()) + ' · ' + S.symbol;
}

/* ══════════ Цикл ══════════ */

let prevT = performance.now(), acc = 0;
function frame(now) {
  const dt = clamp(now - prevT, 0, 120);
  prevT = now;
  if (S.running) {
    acc += dt;
    const tickMs = S.candleMs / TICKS;
    let guard = 0;
    while (acc >= tickMs && guard < 400) { acc -= tickMs; tick(); guard++; }
  }
  draw(now);
  requestAnimationFrame(frame);
}

/* ══════════ Тост ══════════ */

let toastTimer = null;
function toast(text, color) {
  const el = $('#toast');
  el.textContent = text;
  el.style.color = color === 'green' ? '#26a69a' : color === 'red' ? '#ef5350' : '#d1d4dc';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ══════════ Управление ══════════ */

function setRunning(v) {
  S.running = v;
  if (v) { S.autoScroll = true; acc = 0; }
  $('#btnPlay').textContent = v ? '❚❚ Пауза' : '▶ Старт';
  $('#btnPlay').classList.toggle('primary', !v);
}

function applyInputs(regen, anchor) {
  S.symbol = ($('#inSymbol').value || 'TICKER').toUpperCase().trim();
  const lo = parseFloat($('#inLow').value), hi = parseFloat($('#inHigh').value);
  if (isFinite(lo) && isFinite(hi) && lo !== hi) { S.low = Math.min(lo, hi); S.high = Math.max(lo, hi); }
  S.volMult = parseFloat($('#inVol').value);
  if (regen) { genHistory(anchor); clearTarget(); }
  else { S.sigmaTick = sigmaFor(); }
}

function bind() {
  // таймфреймы
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
  document.querySelector('.tf[data-tf="15m"]').classList.add('on');

  $('#btnPlay').addEventListener('click', function () { setRunning(!S.running); this.blur(); });
  $('#btnClean').addEventListener('click', function () {
    document.body.classList.toggle('clean');
    this.classList.toggle('on', document.body.classList.contains('clean'));
    this.blur();
    setTimeout(resize, 30);
  });
  $('#btnFrame').addEventListener('click', function () {
    document.body.classList.toggle('frame');
    this.classList.toggle('on', document.body.classList.contains('frame'));
    this.blur();
    setTimeout(resize, 30);
  });

  $('#btnRegen').addEventListener('click', function () { applyInputs(true); toast('Новая история'); this.blur(); });
  ['#inSymbol', '#inLow', '#inHigh', '#inStart'].forEach((s) =>
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
  $('#inLiq').addEventListener('change', function () { S.useLiq = this.checked; });
  document.querySelectorAll('#quickPct button').forEach((b) => {
    b.addEventListener('click', () => {
      const p = lastPrice() * (1 + parseFloat(b.dataset.pct) / 100);
      $('#inTarget').value = p.toFixed(DEC);
    });
  });

  $('#btnLong').addEventListener('click', () => openPosition('long'));
  $('#btnShort').addEventListener('click', () => openPosition('short'));
  $('#btnClose').addEventListener('click', () => closePosition());

  // мышь на графике
  wrap.addEventListener('mousemove', (e) => {
    const r = cv.getBoundingClientRect();
    S.cross = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (S.drag) {
      const dx = S.cross.x - S.drag.x;
      S.autoScroll = false;
      S.scrollRight = S.drag.right - dx / S.barSpacing;
      S.scrollRight = clamp(S.scrollRight, 4, S.candles.length + 200);
    }
  });
  wrap.addEventListener('mouseleave', () => { S.cross = null; S.drag = null; });
  wrap.addEventListener('mousedown', (e) => {
    const r = cv.getBoundingClientRect();
    S.drag = { x: e.clientX - r.left, right: S.scrollRight };
  });
  window.addEventListener('mouseup', () => { S.drag = null; });
  wrap.addEventListener('dblclick', () => { S.autoScroll = true; toast('К последней свече'); });
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = e.deltaY > 0 ? 0.9 : 1.1;
    S.barSpacing = clamp(S.barSpacing * k, 2, 26);
    $('#inZoom').value = S.barSpacing;
    $('#outZoom').textContent = S.barSpacing.toFixed(0) + ' px';
  }, { passive: false });

  // тач: скролл графика
  wrap.addEventListener('touchstart', (e) => {
    const r = cv.getBoundingClientRect();
    S.drag = { x: e.touches[0].clientX - r.left, right: S.scrollRight };
  }, { passive: true });
  wrap.addEventListener('touchmove', (e) => {
    if (!S.drag) return;
    const r = cv.getBoundingClientRect();
    const x = e.touches[0].clientX - r.left;
    S.autoScroll = false;
    S.scrollRight = clamp(S.drag.right - (x - S.drag.x) / S.barSpacing, 4, S.candles.length + 200);
  }, { passive: true });
  wrap.addEventListener('touchend', () => { S.drag = null; });

  // клавиши
  window.addEventListener('keydown', (e) => {
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); setRunning(!S.running); }
    else if (k === 'b' || k === 'и') openPosition('long');
    else if (k === 's' || k === 'ы') openPosition('short');
    else if (k === 'c' || k === 'с') closePosition();
    else if (k === 'h' || k === 'р') $('#btnClean').click();
    else if (k === 'v' || k === 'м') $('#btnFrame').click();
    else if (k === 'r' || k === 'к') $('#btnRegen').click();
    else if (k === 't' || k === 'е') setTarget();
  });

  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(wrap);
}

/* ══════════ Старт ══════════ */

function init() {
  bind();
  applyInputs(true);
  clearTarget();
  S.candleMs = parseFloat($('#inSpeed').value) * 1000;
  S.barSpacing = parseFloat($('#inZoom').value);
  S.useLiq = $('#inLiq').checked;
  resize();
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();

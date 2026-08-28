'use strict';
/**
 * indicators.js — 指标库
 * 日线: MA/EMAs/MACD/KDJ/BOLL/RSI/量能结构 ; 分钟级: VWAP/分段量能/拉升窗口/回吐比/尾盘行为
 */

/* ---------- 基础序列 ---------- */
function sma(a, n) {
  const out = new Array(a.length).fill(null);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i];
    if (i >= n) sum -= a[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
// 同花顺口径的递推 EMA（首值 seeding，配合足够预热长度）
function ema(a, n) {
  const out = new Array(a.length).fill(null);
  if (!a.length) return out;
  out[0] = a[0];
  for (let i = 1; i < a.length; i++) out[i] = (2 * a[i] + (n - 1) * out[i - 1]) / (n + 1);
  return out;
}
function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const dif = closes.map((_, i) => ef[i] - es[i]);
  const dea = ema(dif, sig);
  const hist = dif.map((d, i) => 2 * (d - dea[i]));
  return { dif, dea, hist };
}
function kdj(bars, n = 9) {
  const K = new Array(bars.length).fill(null), D = [...K], J = [...K];
  let k = 50, d = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i < n - 1) continue;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, bars[j].high); ll = Math.min(ll, bars[j].low); }
    const rsv = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100;
    k = (2 * k + rsv) / 3; d = (2 * d + k) / 3;
    K[i] = k; D[i] = d; J[i] = 3 * k - 2 * d;
  }
  return { K, D, J };
}
function rsiWilder(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= n) { avgG += g / n; avgL += l / n; if (i === n) out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL); }
    else { avgG = (avgG * (n - 1) + g) / n; avgL = (avgL * (n - 1) + l) / n; out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL); }
  }
  return out;
}
const last = (a) => a[a.length - 1];
const lastNum = (a) => { for (let i = a.length - 1; i >= 0; i--) if (isFinite(a[i])) return a[i]; return NaN; };

/* ---------- 日线汇总 ---------- */
/** 涨停制度幅度: 创业板/科创板20%, 北交所30%, 其余10% */
function limitUpPct(code) {
  return /^(68|30)/.test(code) ? 20 : /^(92|43|83|87)/.test(code) ? 30 : 10;
}

function dailySummary(bars, winN = 20, code = '') {
  const closes = bars.map((b) => b.close), vols = bars.map((b) => b.volume), highs = bars.map((b) => b.high);
  const ma5 = lastNum(sma(closes, 5)), ma10 = lastNum(sma(closes, 10)), ma20 = lastNum(sma(closes, 20)), ma60 = lastNum(sma(closes, 60));
  const m = macd(closes), k = kdj(bars), r = rsiWilder(closes);
  const t = bars[bars.length - 1];
  const w = bars.slice(-winN);
  const winHi = Math.max(...w.map((b) => b.high)), winLo = Math.min(...w.map((b) => b.low));
  // 量价健康度: 上涨日均量 / 下跌日均量
  const upV = [], dnV = [];
  for (let i = Math.max(1, bars.length - 60); i < bars.length; i++) (bars[i].pct >= 0 ? upV : dnV).push(vols[i]);
  const uv = upV.length ? upV.reduce((s, x) => s + x, 0) / upV.length : NaN;
  const dv = dnV.length ? dnV.reduce((s, x) => s + x, 0) / dnV.length : NaN;
  // 天量长阴遗迹(近15日内出现 巨量>1.8×MA20 且 跌幅>6%)
  const vm20 = sma(vols, 20);
  let blowoff = null;
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - 15); i--) {
    if (isFinite(vm20[i]) && vols[i] > 1.8 * vm20[i] && bars[i].pct < -6) { blowoff = { date: bars[i].date, daysAgo: bars.length - 1 - i, pct: bars[i].pct }; break; }
  }
  // 近5日放量趋势: 后5日均量 / 前15日均量
  const recent5 = vols.slice(-5), prev15 = vols.slice(-20, -5);
  const volAccel = prev15.length ? recent5.reduce((s, x) => s + x, 0) / 5 / (prev15.reduce((s, x) => s + x, 0) / prev15.length) : NaN;
  const cumWin = (w.length >= 2 ? (w[w.length - 1].close / w[0].open - 1) * 100 : NaN);
  const posPct = winHi > winLo ? ((t.close - winLo) / (winHi - winLo)) * 100 : 50;
  // 涨停板质量: 涨停价=昨收×(1+制度幅度)四舍五入到分; 摸板/封板/炸板
  let boardQ = null;
  const prevBar = bars[bars.length - 2];
  if (code && prevBar && prevBar.close > 0) {
    const limitPrice = Math.round(prevBar.close * (1 + limitUpPct(code) / 100) * 100) / 100;
    const touched = t.high >= limitPrice - 0.001;
    boardQ = { limitPrice, touched, sealed: touched && t.close >= limitPrice - 0.001, broken: touched && t.close < limitPrice - 0.001 };
  }
  // 位置结构分级
  let posTag = '破位下行';
  if (t.close >= winHi * 0.995 || (bars.length >= 2 && t.close >= Math.max(...bars.slice(-21, -1).map((b) => b.high)))) posTag = '创阶段新高';
  else if (posPct >= 70) posTag = '高位整理';
  else if (posPct >= 40) posTag = '中继修复';
  return {
    date: t.date, close: t.close, pctToday: t.pct,
    ma: { ma5, ma10, ma20, ma60 },
    aboveMa: { m5: t.close > ma5, m10: t.close > ma10, m20: t.close > ma20, m60: t.close > ma60 },
    macd: { dif: last(m.dif), dea: last(m.dea), hist: last(m.hist), crossUp: last(m.dif) > last(m.dea) },
    kdj: { k: lastNum(k.K), d: lastNum(k.D), j: lastNum(k.J) },
    rsi14: lastNum(r),
    winHi, winLo, posPct, cumWin,
    vol: { todayVol: t.volume, accel: volAccel, upDownRatio: isFinite(uv) && isFinite(dv) && dv > 0 ? uv / dv : NaN },
    blowoff, posTag, boardQ,
  };
}

/* ---------- 分钟级特征 ---------- */
function minutesToMin(tstr) {
  const m = String(tstr).match(/(\d{2}):(\d{2})\s*$/);
  return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : NaN;
}
function intradaySummary(minBars, prevClose) {
  if (!minBars || !minBars.length) return null;
  let amt = 0, vol = 0;
  for (const b of minBars) { amt += b.amount; vol += b.volume; }
  const vwap = vol > 0 ? amt / vol : NaN;
  const closeP = last(minBars).close;
  const openP = minBars[0].open;
  let hi = -Infinity, hiT = '', lo = Infinity, loT = '';
  const bs = {};
  for (const b of minBars) {
    const mm = minutesToMin(b.time);
    if (!isNaN(mm)) { const slot = Math.floor(mm / 30) * 30; (bs[slot] = bs[slot] || { vol: 0 }); bs[slot].vol += b.volume; }
    if (b.high > hi) { hi = b.high; hiT = String(b.time).slice(-5); }
    if (b.low < lo) { lo = b.low; loT = String(b.time).slice(-5); }
  }
  const totalVol = vol;
  const bucket = Object.keys(bs).sort((a, b) => a - b).map((k) => {
    const mins = Number(k);
    const label = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    return { slot: label, share: (bs[k].vol * 100) / totalVol };
  });
  // 最强5分钟窗口
  let runs = [];
  for (let i = 5; i < minBars.length; i++) {
    const g = (minBars[i].close / minBars[i - 5].close - 1) * 100;
    runs.push({ till: String(minBars[i].time).slice(-5), gain: g });
  }
  runs.sort((a, b) => b.gain - a.gain);
  // 回吐比例: 冲高最大浮盈回吐了多少
  let run = [];
  const gains = minBars.map((b) => prevClose ? (b.high / prevClose - 1) * 100 : NaN);
  const maxGain = Math.max(...gains.filter(isFinite));
  const finalGain = prevClose ? (closeP / prevClose - 1) * 100 : NaN;
  const giveupRatio = maxGain > 0 ? ((maxGain - finalGain) / maxGain) * 100 : NaN;
  // 尾盘30分钟
  const tail30 = minBars.slice(-30);
  const tailRet = (last(minBars).close / tail30[0].close - 1) * 100;
  const tailShare = (tail30.reduce((s, b) => s + b.volume, 0) * 100) / totalVol;
  // 早盘(≤11:30)量占比
  let amVol = 0;
  for (const b of minBars) { const mm = minutesToMin(b.time); if (!isNaN(mm) && mm <= 690) amVol += b.volume; }
  return {
    bars: minBars.length, open: openP, close: closeP, high: hi, highTime: hiT, low: lo, lowTime: loT,
    vwap, aboveVwapClose: closeP >= vwap,
    earlyVolShare: (amVol * 100) / totalVol,
    buckets: bucket,
    bestRuns: runs.slice(0, 3),
    giveupRatio,               // % 越小越强(<50偏真实承接)
    tail: { ret: tailRet, volShare: tailShare },
  };
}

/* ---------- 触发确认(盘中实时判定用) ---------- */
// A卡: 现价站上累计VWAP ; B卡: 带内分钟级连续回升 + 回调段缩量(<ratio×此前均量)
function evaluateConfirmations(minBars, opt = {}) {
  const res = { hasData: !!(minBars && minBars.length > 5), aboveVwap: null, stabilized: null, retractVolRatio: NaN };
  if (!res.hasData) return res;
  let amt = 0, vol = 0;
  for (const b of minBars) { amt += b.amount; vol += b.volume; }
  const vwap = vol > 0 ? amt / vol : NaN;
  const lastClose = minBars[minBars.length - 1].close;
  res.vwap = vwap;
  if (opt.px != null && isFinite(vwap)) res.aboveVwap = opt.px >= vwap;
  const c = minBars.slice(-3).map((b) => b.close);
  if (opt.stabilize !== false && c.length === 3) res.stabilized = c[0] < c[1] && c[1] <= c[2];

  /* B卡企稳v2(T+1口径): 买入次日才能卖, 企稳必须给"明天不会更低"足够依据
     ①低点抬升: 近6根中≥4根收盘抬升(纯3根反抽不再算数)
     ②收复近15分钟VWAP: 不仅止跌, 还要收回失地
     ③下跌未放量: 近5分钟均量 ≤ 前20分钟均量(恐慌抛售中"缩量"不再视为企稳证据) */
  const c6 = minBars.slice(-6).map((b) => b.close);
  if (opt.stabilize !== false && c6.length === 6) {
    const ups = c6.slice(1).filter((x, i) => x > c6[i]).length;
    const lowsRising = ups >= (opt.lowsRisingMin ?? 4);
    let v15amt = 0, v15vol = 0;
    for (const b of minBars.slice(-15)) { v15amt += b.amount; v15vol += b.volume; }
    const vwap15 = v15vol > 0 ? v15amt / v15vol : NaN;
    res.vwap15 = vwap15;
    const reclaim = opt.px != null && isFinite(vwap15) ? opt.px >= vwap15 : isFinite(vwap15) ? lastClose >= vwap15 : false;
    res.reclaimVwap15 = reclaim;
    res.stabilized = lowsRising && reclaim;
  }
  const tailVol = minBars.slice(-5).reduce((s, b) => s + b.volume, 0) / 5;
  const prior = minBars.slice(-25, -5);
  if (prior.length >= 10) {
    const priorAvg = prior.reduce((s, b) => s + b.volume, 0) / prior.length;
    if (priorAvg > 0) res.retractVolRatio = tailVol / priorAvg;
  }
  // 突破放量比: 最近3分钟均量 ÷ 此前30分钟均量 (A卡确认用)
  res.breakoutVolRatio = NaN;
  if (minBars.length >= 33) {
    const v3 = minBars.slice(-3).reduce((s, b) => s + b.volume, 0) / 3;
    const p30 = minBars.slice(-33, -3);
    const pa = p30.reduce((s, b) => s + b.volume, 0) / p30.length;
    if (pa > 0) res.breakoutVolRatio = v3 / pa;
  }
  return res;
}

module.exports = { sma, ema, macd, kdj, rsiWilder, dailySummary, intradaySummary, evaluateConfirmations, limitUpPct, numHelpers: { last, lastNum } };

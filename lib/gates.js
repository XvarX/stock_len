'use strict';
/**
 * gates.js — A/B 买点关卡评估(纯函数)
 * monitor.js(实时轮询) 与 backtest.js(分钟重放) 共用同一份逻辑, 防止双实现漂移。
 * 市场门/板块门由调用方解析后以 marketOk/sectorOk 布尔传入(回放场景板块门退化为放行并标注)。
 */
const IND = require('./indicators');

const DEFAULTS = {
  aRequireVwap: true, aVolRatioMin: 2, aMaxChasePct: 2, aFlowMin: 0,
  bRequireStabilize: true, bRetractVolRatioMax: 1.0, bVolStructure: true,
  bMarketConfirm: true, bMarketMin: -1, bSectorConfirm: true, bSectorMin: -1,
};

function limitUpPriceOf(prevClose, code) {
  return Math.round(prevClose * (1 + IND.limitUpPct(code) / 100) * 100) / 100;
}

/** A卡七关。o: {item:{code,A:{trigger},prevClose,flow}, price, bars, conf, marketOk, sectorOk} */
function evaluateA(o) {
  const conf = Object.assign({}, DEFAULTS, o.conf || {});
  const it = o.item, p = o.price, bars = o.bars || [];
  const cf = IND.evaluateConfirmations(bars, { px: p, stabilize: false });
  const gates = [];
  // 追深上限: 常规2%; 若启用迟到确认(aLateMaxPct), 放宽到该宽度(承认买贵换确定性)
  const chaseCap = conf.aLateMaxPct != null ? conf.aLateMaxPct : conf.aMaxChasePct;
  gates.push(['追深', p <= it.A.trigger * (1 + chaseCap / 100)]);
  const lp = it.prevClose > 0 ? limitUpPriceOf(it.prevClose, it.code) : null;
  gates.push(['未封板', !(lp != null && p >= lp - 0.001)]);
  gates.push(['VWAP', !conf.aRequireVwap || cf.aboveVwap === true]);
  gates.push(['放量比', !isFinite(cf.breakoutVolRatio) || cf.breakoutVolRatio >= conf.aVolRatioMin]);
  gates.push(['量结构', cf.bounceVolOk !== false]); // null=样本不足放行
  gates.push(['资金', it.flow == null || it.flow.today == null || !isFinite(it.flow.today) || it.flow.today >= conf.aFlowMin]);
  gates.push(['站稳5分钟', bars.length < 5 || bars.slice(-5).every((b) => b.close >= it.A.trigger * 0.99)]);
  if (o.marketOk !== undefined) gates.push(['市场', o.marketOk]);
  if (o.sectorOk !== undefined) gates.push(['板块', o.sectorOk]);
  const failed = gates.filter((g) => !g[1]).map((g) => g[0]);
  return {
    pass: failed.length === 0, failed, cf, price: p,
    detail: `VWAP(${cf.vwap ? cf.vwap.toFixed(2) : '-'}):${cf.aboveVwap === true ? '过' : '未过'} 放量比(${isFinite(cf.breakoutVolRatio) ? cf.breakoutVolRatio.toFixed(1) : '-'}/${conf.aVolRatioMin})`,
  };
}

/** B卡六关(入带由调用方先判)。o: {item:{code,B:{zone,stop,anchor},flow}, price, openPrice, bars, conf, marketOk, sectorOk} */
function evaluateB(o) {
  const conf = Object.assign({}, DEFAULTS, o.conf || {});
  const it = o.item, p = o.price, bars = o.bars || [];
  const cf = IND.evaluateConfirmations(bars, {});
  const gates = [];
  gates.push(['企稳v2', !conf.bRequireStabilize || cf.stabilized === true]);
  gates.push(['缩量', !isFinite(cf.retractVolRatio) || cf.retractVolRatio <= conf.bRetractVolRatioMax]);
  gates.push(['量价结构', cf.bounceVolOk !== false]);
  const bFlowOk = it.flow == null || it.flow.today == null || !isFinite(it.flow.today)
    ? true : (it.flow.today >= -5e7 && (it.flow.cum5 == null || !isFinite(it.flow.cum5) || it.flow.cum5 > 0));
  gates.push(['资金', bFlowOk]);
  const shallow = String(it.B.anchor || '').startsWith('浅锚');
  gates.push(['浅锚破开盘', !(shallow && o.openPrice > 0 && p < o.openPrice)]);
  gates.push(['市场', o.marketOk !== undefined ? o.marketOk : true]);
  gates.push(['板块', o.sectorOk !== undefined ? o.sectorOk : true]);
  const failed = gates.filter((g) => !g[1]).map((g) => g[0]);
  return {
    pass: failed.length === 0, failed, cf, price: p,
    detail: `企稳:${cf.stabilized} 量价结构:${cf.bounceVolOk} 缩量比:${isFinite(cf.retractVolRatio) ? cf.retractVolRatio.toFixed(2) : '-'}`,
  };
}

module.exports = { evaluateA, evaluateB, DEFAULTS, limitUpPriceOf };

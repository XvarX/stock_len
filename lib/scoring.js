'use strict';
/**
 * scoring.js — 策略引擎
 * 市场温度计(三档) / 板块情绪周期(四阶段) / 个股评分 / A·B买点卡 / 竞价校准
 */
const CFG = (() => JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config.json'), 'utf-8')))();

const r2 = (x) => Math.round(x * 100) / 100;

/* ---------- 市场温度计 ---------- */
function marketTemperature(indices) {
  // indices: [{name, bars:[{close,pct,...}]}]
  const detail = [];
  let votes = { attack: 0, watch: 0, defend: 0 };
  for (const idx of indices) {
    const closes = idx.bars.map((b) => b.close);
    const n = closes.length;
    const ma20 = closes.slice(-20).reduce((s, x) => s + x, 0) / Math.min(20, n);
    const c = closes[n - 1];
    const mom5 = idx.bars.slice(-5).reduce((s, b) => s + b.pct, 0);
    const regime = c > ma20 ? (mom5 > 0 ? 'attack' : 'watch') : (mom5 < 0 ? 'defend' : 'watch');
    votes[regime]++;
    detail.push({ name: idx.name, close: c, aboveMa20: c > ma20, mom5, regime });
  }
  let overall = 'watch';
  if (votes.attack === indices.length) overall = 'attack';
  else if (votes.attack === 0 && votes.defend > 0) overall = 'defend';
  return { overall, label: { attack: '进攻', watch: '观望', defend: '防守' }[overall], detail };
}

/* ---------- 板块情绪周期 ---------- */
function boardStage(board) {
  if (!board || board.pctToday === null && !board.series) return { stage: 'unknown', label: '数据不足', reason: '未取到板块数据' };
  if (!board.series) return { stage: 'insufficient', label: `仅当日口径(${board.pctToday > 0 ? '+' : ''}${board.pctToday}%)`, reason: '服务端未返回板块日度序列，无法定位周期阶段' };
  const s = board.series.map((x) => x.pct);
  const recent5 = s.slice(-5), prior15 = s.slice(-20, -5);
  const rMean = recent5.reduce((a, b) => a + b, 0) / recent5.length;
  const pMean = prior15.length ? prior15.reduce((a, b) => a + b, 0) / prior15.length : 0;
  const accel = pMean !== 0 ? rMean / Math.abs(pMean) : (rMean > 0 ? 9 : -9);
  const today = s[s.length - 1];
  let stage, reason;
  if (rMean < 0 && accel < 0.7) { stage = 'retreat'; reason = `近5日均涨${rMean.toFixed(2)}%转弱、动量衰减`; }
  else if (recent5.reduce((a, b) => a + b, 0) > 6 && today <= 0) { stage = 'climax'; reason = '近5日累计涨幅大但今日转跌——高潮后分歧特征'; }
  else if (accel >= 1.5 && rMean > 3) { stage = 'mainup'; reason = `涨幅加速(近5日均${rMean.toFixed(2)}% vs 前15日均${pMean.toFixed(2)}%)`; }
  else if (accel >= 1.2 && rMean > 0) { stage = 'launch'; reason = `温和启动(近5日均${rMean.toFixed(2)}%)`; }
  else if (accel < 0.7) { stage = 'retreat'; reason = `板块动量衰减(加速度${accel.toFixed(2)})`; }
  else { stage = 'mid'; reason = `中继震荡(近5日均${rMean.toFixed(2)}%)`; }
  return { stage, label: { launch: '启动', mainup: '主升', climax: '高潮分歧', retreat: '退潮', mid: '中继', insufficient: '数据不足', unknown: '数据不足' }[stage], reason };
}

/* ---------- 个股评分 ---------- */
function scoreStock(ds, ctx = {}) {
  // ds: dailySummary ; ctx: {idxCum20, boardAvg20}
  const clamp = (x) => Math.max(0, Math.min(100, x));
  const lin = (x, lo, hi) => ((x - lo) / (hi - lo)) * 100;
  // ① 相对强度 40%: 取与大盘/板块超额的较大者
  const exIdx = isFinite(ctx.idxCum20) ? ds.cumWin - ctx.idxCum20 : NaN;
  const exBoard = isFinite(ctx.boardAvg20) ? ds.cumWin - ctx.boardAvg20 : NaN;
  const exBest = Math.max(isFinite(exIdx) ? exIdx : -99, isFinite(exBoard) ? exBoard : -99);
  const rsScore = clamp(exBest <= -5 ? 10 : exBest < 0 ? 30 : exBest < 3 ? 45 : exBest < 8 ? 60 : exBest < 15 ? 82 : 100);
  // ② 位置结构 30%
  const posMap = { '创阶段新高': 100, '高位整理': 72, '中继修复': 48, '破位下行': 12 };
  let posScore = posMap[ds.posTag] ?? 40;
  // ③ 量价健康 30%
  const udr = ds.vol.upDownRatio;
  let healthScore = !isFinite(udr) ? 50 : udr >= 1.3 ? 92 : udr >= 1.0 ? 70 : udr >= 0.8 ? 48 : 22;
  if (isFinite(ds.vol.accel)) healthScore += ds.vol.accel > 3.5 ? -18 : ds.vol.accel >= 0.8 && ds.vol.accel <= 2.8 ? 6 : -4;
  // 资金因子: 主力净流入方向与5日累计共振加分, 背离/单日大流出扣分
  if (ds.flow && isFinite(ds.flow.today) && isFinite(ds.flow.cum5)) {
    if (ds.flow.today > 0 && ds.flow.cum5 > 0) healthScore += 10;
    else if (ds.flow.today < 0 && ds.flow.cum5 < 0) healthScore -= 12;
    else if (ds.flow.today < 0 && ds.flow.cum5 > 0 && Math.abs(ds.flow.today) > ds.flow.cum5) healthScore -= 5; // 单日流出吞掉5日净流入
  }
  const blowPenalty = ds.blowoff && ds.blowoff.daysAgo <= 10 ? 22 : 0;
  const composite = clamp(rsScore * 0.4 + posScore * 0.3 + healthScore * 0.3 - blowPenalty);
  return {
    composite: Math.round(composite),
    grade: composite >= 75 ? '强（可操作）' : composite >= 55 ? '中（观察）' : '弱（放弃）',
    parts: { rsScore: Math.round(rsScore), rsExcess: { vsIndex: r2(exIdx), vsBoard: r2(exBoard) }, posScore, healthScore: Math.round(clamp(healthScore)), blowPenalty },
    summary: `${ds.posTag} | 20日区间${ds.posPct.toFixed(0)}%分位 | 涨量/跌量比 ${isFinite(udr) ? udr.toFixed(2) : '-'}${ds.flow && isFinite(ds.flow.today) ? ` | 主力今日${ds.flow.today >= 0 ? '+' : ''}${(ds.flow.today / 1e8).toFixed(2)}亿` : ''}${ds.blowoff ? ` | ⚠天量长阴遗迹(${ds.blowoff.date},${ds.blowoff.daysAgo}日前)` : ''}`,
  };
}

/* ---------- A/B 买点卡 ---------- */
function buildCards(code, name, ds, temp, stage) {
  const B = CFG.breakout, P = CFG.pullback, R = CFG.risk;
  const guards = [];
  const allowBase = !(temp.overall === 'defend');
  if (temp.overall === 'defend') guards.push('市场温度计=防守档：全部卡片降级观望');
  if (stage.stage === 'retreat') guards.push('板块退潮：禁止A卡');
  if (ds.posTag === '破位下行') guards.push('个股破位：仅观望');
  // 前高参照: 近20日(含最新收盘日)最高价
  const level = r2(ds.winHi);
  const aTrigger = r2(level * (1 + B.triggerAboveLevel));
  const aZoneTop = r2(level * (1 + B.zoneTopPct));
  const aStop = r2(aTrigger * (1 - R.stopPct / 100));
  // 低吸关键位: MA10 与 近10日平台低点 取最高者作为第一参考
  const ma10 = ds.ma.ma10;
  const platformLow = r2(Math.min(...(ds.winLo ? [ds.winLo] : [ma10]))); // 近20日最低
  const key = r2(Math.max(ma10, platformLow));
  const bZoneLo = r2(key * 0.99), bZoneHi = r2(key * 1.01);
  const bStop = r2(key * (1 - P.stopBelowKeyPct));
  const disabledA = !allowBase || stage.stage === 'retreat' || ds.posTag === '破位下行';
  const disabledB = !allowBase || ds.posTag === '破位下行';
  return {
    code, name,
    refClose: ds.close,
    A: {
      status: disabledA ? '禁用' : '待触发',
      forbidReasons: guards.filter((g) => g.includes('防守') || g.includes('退潮') || g.includes('破位')),
      trigger: aTrigger, zone: [aTrigger, aZoneTop], stop: aStop, holdDays: '1-5',
      confirm: '盘中价≥触发价 且 分时站上VWAP 且 板块同向上涨',
      desc: `突破${CFG.analysisWindow}日高点${level}`,
    },
    B: {
      status: disabledB ? '禁用' : '待触发',
      forbidReasons: guards.filter((g) => g.includes('防守') || g.includes('破位')),
      keyLevels: { MA10: r2(ma10), platformLow },
      key: Math.max(ma10, platformLow).toFixed(2) === key.toFixed(2) ? 'MA10为主' : '平台低点为主',
      zone: [bZoneLo, bZoneHi], stop: bStop, holdDays: '1-5',
      confirm: '缩量回踩带内后收出企稳阳线(回调段量<近5日均量×0.8)',
      desc: '回踩关键位低吸',
    },
    guardNotes: guards,
  };
}

/* ---------- 9:25 竞价校准 ---------- */
function auctionAdjust(cards, snap, prevClose) {
  const out = { code: cards.code, adjustments: [], updated: cards };
  if (!snap || !isFinite(snap.latest)) { out.adjustments.push('⚠ 未取到竞价快照，维持原计划'); return out; }
  const base = snap.openPrice > 0 ? snap.openPrice : snap.latest;
  const gap = prevClose > 0 ? base / prevClose - 1 : 0;
  out.gapPct = r2(gap * 100);
  if (cards.A.status === '待触发') {
    if (gap > CFG.breakout.maxGapAbandon) { out.updated.A.status = '作废'; out.adjustments.push(`⛔ 高开${out.gapPct}%>上限5%，追高风险过大，A卡作废`); }
    else if (gap < -0.03) { out.updated.A.status = '观望'; out.adjustments.push(`▼ 低开${out.gapPct}%<-3%，A卡降为观望，尾盘再评估`); }
    else out.adjustments.push(`✓ 竞价${gap >= 0 ? '+' : ''}${out.gapPct}%，A卡价位带不变`);
  } else out.adjustments.push(`- A卡状态[${cards.A.status}]不参与竞价调整`);
  if (cards.B.status === '待触发' && gap > 0.04) out.adjustments.push(`△ 高开${out.gapPct}%：B卡低吸带相对抬高，以带内实际回踩为准`);
  return out;
}

module.exports = { marketTemperature, boardStage, scoreStock, buildCards, auctionAdjust };

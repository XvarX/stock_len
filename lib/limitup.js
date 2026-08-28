'use strict';
/**
 * limitup.js — 涨停/连板结构分析(基于日线, 龙头识别v2核心)
 * 局限(如实): 涨停时间戳/封单量不可得, 封板质量用日线close=涨停价近似
 */
const { limitUpPct } = require('./indicators');

function limitPriceOf(prevClose, code) {
  return Math.round(prevClose * (1 + limitUpPct(code) / 100) * 100) / 100;
}
function isLimitUpBar(bar, prevClose, code) {
  return !!(bar && prevClose > 0 && bar.close > 0 && bar.close >= limitPriceOf(prevClose, code) - 0.001);
}
function isOneWordBar(bar, limitPrice) {
  return [bar.open, bar.high, bar.low, bar.close].every((x) => Math.abs(x - limitPrice) < 0.001);
}

/** 连板结构: 从最新一根bar向前数连续涨停 */
function boardStreak(bars, code) {
  const empty = { boards: 0, firstDate: null, oneWordToday: false, sealedToday: false };
  if (!bars || bars.length < 3) return empty;
  let boards = 0, firstDate = null;
  for (let i = bars.length - 1; i >= 1; i--) {
    if (!isLimitUpBar(bars[i], bars[i - 1].close, code)) break;
    boards++;
    firstDate = bars[i].date;
  }
  if (!boards) return empty;
  const t = bars[bars.length - 1];
  const lp = limitPriceOf(bars[bars.length - 2].close, code);
  return { boards, firstDate, oneWordToday: isOneWordBar(t, lp), sealedToday: t.close >= lp - 0.001 };
}

/** 梯队统计: streaks=[{boards}] → {first, second, thirdPlus, max} */
function ladderStats(streaks) {
  const s = { first: 0, second: 0, thirdPlus: 0, max: 0 };
  for (const x of streaks) {
    const b = x.boards || 0;
    if (b >= 3) s.thirdPlus++;
    else if (b === 2) s.second++;
    else if (b === 1) s.first++;
    s.max = Math.max(s.max, b);
  }
  return s;
}

/**
 * 情绪周期定位(候选池口径)。
 * 注意: 市场真实最高连板≥候选池值; 冰点/退潮区分需晋级率历史(Phase 2), v1合并为"低迷"。
 */
function classifyEmotion(limitUpCount, maxBoards) {
  if ((limitUpCount >= 100 || maxBoards >= 6)) return { regime: 'overheat', label: '过热警戒(高潮期: 只卖不追, 严禁新开仓)' };
  if (maxBoards >= 3 || limitUpCount >= 30) return { regime: 'normal', label: '正常(主线龙头可作, 分歧低吸优先)' };
  return { regime: 'low', label: '低迷(仅首板先手/轻仓观察, 冰点或退潮待晋级率数据区分)' };
}

/** 五维龙头分(0-100): 时序25 高度30 带动20 换手质量15 资金10 */
function leaderScore({ boards, firstDateRank, clusterHits, oneWordToday, broken, flowToday }) {
  const height = boards >= 3 ? 95 : boards === 2 ? 70 : 40;
  const time = (firstDateRank == null || firstDateRank < 0) ? 50 : [100, 82, 64, 50][Math.min(firstDateRank, 3)];
  const drive = clusterHits >= 5 ? 100 : clusterHits === 4 ? 85 : clusterHits === 3 ? 70 : clusterHits === 2 ? 55 : 30;
  const quality = oneWordToday ? 40 : broken ? 20 : 90;
  const flow = !isFinite(flowToday) ? 55 : flowToday >= 2e8 ? 100 : flowToday >= 1e8 ? 80 : flowToday >= 0 ? 60 : 30;
  const score = Math.round(height * 0.30 + time * 0.25 + drive * 0.20 + quality * 0.15 + flow * 0.10);
  return {
    score,
    grade: score >= 80 ? '龙头候选' : score >= 60 ? '梯队成员' : '跟风/观察',
    parts: { height, time, drive, quality, flow },
  };
}

module.exports = { limitPriceOf, isLimitUpBar, boardStreak, ladderStats, classifyEmotion, leaderScore };

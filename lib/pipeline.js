'use strict';
/**
 * pipeline.js — 编排核心: 市场上下文 / 单票深析 / 自动扫描龙头 / 复盘
 */
const CFG = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config.json'), 'utf-8'));
const { num } = require('./fetchers');
const S = require('./scoring');
const IND = require('./indicators');

const GENERIC_CONCEPTS = new Set(['融资融券', '深股通', '沪股通', '转融券标的', '标普道琼斯A股', '富时罗素概念', 'MSCI中国', '同花顺漂亮100', '机构重仓', '基金重仓']);

/** 市场温度计基准 */
async function marketContext(f) {
  const indices = [];
  for (const name of CFG.benchmarks) {
    const r = await f.dailyIndex(name, 35);
    indices.push({ name, ok: r.ok, bars: r.bars || [] });
  }
  const temp = S.marketTemperature(indices.filter((x) => x.ok));
  const bench = indices.find((x) => x.name === '创业板指') || indices.find((x) => x.ok);
  const cum20 = bench && bench.bars.length >= 2 ? bench.bars.slice(-20).reduce((s, b) => s + b.pct, 0) : NaN;
  const todayPct = bench && bench.bars.length ? bench.bars[bench.bars.length - 1].pct : NaN;
  const lastDate = bench && bench.bars.length ? bench.bars[bench.bars.length - 1].date : null;
  return { temp, benchCum20: cum20, benchTodayPct: todayPct, dataDate: lastDate };
}

/** 选板块: 非通用概念优先 */
function pickBoard(concepts) {
  const cs = Array.isArray(concepts) ? concepts : String(concepts || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  const nonGeneric = cs.filter((c) => !GENERIC_CONCEPTS.has(c));
  return nonGeneric[0] || cs[0] || null;
}

/** 多票深度分析(含分时与买点卡) */
async function deepAnalyze(f, codes, opts = {}) {
  const ctx = await marketContext(f);
  const stageCache = {};
  const stocks = [];
  for (const code of codes) {
    const idt = await f.identity(code);
    const daily = await f.dailyStock(code, CFG.dailyCalDays);
    if (!daily.ok) { stocks.push({ code, error: `日线获取失败: ${daily.error}` }); continue; }
    const ds = IND.dailySummary(daily.bars, CFG.analysisWindow);
    let boardData = null, stage = { stage: 'unknown', label: '未取' };
    const boardName = pickBoard(idt.concepts);
    if (boardName) {
      if (!stageCache[boardName]) {
        const bd = await f.board(boardName);
        stageCache[boardName] = { raw: bd, stageInfo: S.boardStage(bd) };
      }
      boardData = stageCache[boardName].raw;
      stage = stageCache[boardName].stageInfo;
    }
    const boardAvg20 = boardData && boardData.series && boardData.series.length >= 5
      ? boardData.series.slice(-20).reduce((s, x) => s + x.pct, 0) : NaN;
    const score = S.scoreStock(ds, { idxCum20: ctx.benchCum20, boardAvg20 });
    const cards = S.buildCards(code, idt.name || code, ds, ctx.temp, stage);
    if (score.grade.startsWith('弱')) { // 综合评分弱: 直接从可操作名单中拿掉
      cards.A.status = '禁用'; cards.B.status = '禁用';
      cards.guardNotes.push(`综合评分${score.composite}(弱): 不建议参与`);
    }
    // 分时特征(仅当日有效)
    let intra = null;
    if (!opts.noIntraday) {
      try {
        const m = await f.intraday([code]);
        const prevClose = ds.close / (1 + ds.pctToday / 100);
        intra = IND.intradaySummary(m[code], isFinite(prevClose) ? prevClose : NaN);
      } catch {}
    }
    stocks.push({ code, name: idt.name || code, swIndustry: idt.swIndustry, board: boardName, ds, score, stage, cards, intraday: intra, barsTail: daily.bars.slice(-CFG.analysisWindow) });
  }
  return { ctx, stocks };
}

/** --scan 自动找热度板块与候选龙头 */
async function scanLeaders(f) {
  const ctx = await marketContext(f);
  if (ctx.temp.overall === 'defend') return { ctx, halted: true, reason: '温度计防守档——今天整体休息，不产生候选池' };
  // ① 大涨股集群
  const r = await f.c.biz('stock', 'search_stocks', { query: `今日涨幅大于${CFG.scan.bigGainPct}%的非ST股票` });
  let rows = [];
  if (r.ok && r.inner?.answer) rows = require('./ifind').parseMarkdownTable(String(r.inner.answer));
  const movers = rows
    .map((x) => ({ code: String(x.code || '').split('.')[0], name: x.name || '', pct: num(x.pct) }))
    .filter((x) => /^\d{6}$/.test(x.code) && isFinite(x.pct))
    .sort((a, b) => b.pct - a.pct);
  if (!movers.length) return { ctx, halted: true, reason: `今日涨幅>${CFG.scan.bigGainPct}%的股票为空或查询失败——无短线热度` };
  // ② 概念聚合(逐票拉身份并统计共现)
  const probe = movers.slice(0, Math.min(movers.length, CFG.scan.candidateN));
  const counts = {};
  const conceptsOf = {};
  for (const m of probe) {
    const idt = await f.identity(m.code);
    if (!idt.ok) continue;
    conceptsOf[m.code] = idt.concepts;
    for (const cpt of idt.concepts) {
      if (GENERIC_CONCEPTS.has(cpt)) continue;
      (counts[cpt] = counts[cpt] || new Set()).add(m.code);
    }
  }
  const boards = Object.entries(counts)
    .map(([name, set]) => ({ name, hits: set.size }))
    .filter((b) => b.hits >= 2) // 至少2只大涨股共有才算集群热点
    .sort((a, b) => b.hits - a.hits);
  if (!boards.length) return { ctx, halted: true, reason: '大涨股分散在各自孤立题材中，未形成≥2只共鸣的热点板块——情绪散点期，建议轻仓或观望' };
  const chosen = boards.slice(0, CFG.scan.boardTopN);
  // ③ 候选=热点板内的大涨股(按涨幅序), 保持池内即热板块成员
  const candidates = probe
    .filter((m) => (conceptsOf[m.code] || []).some((cpt) => chosen.some((b) => b.name === cpt)))
    .slice(0, CFG.scan.candidateN)
    .map((m) => m.code);
  return { ctx, halted: false, boards: chosen, rawGainCount: movers.length, candidates };
}

/** 收盘复盘: 计划 vs 实际 */
function buildReview(plan, analyzed, alerts) {
  const lines = [`# 收盘复盘 · ${plan.targetDate}`, '', `市场温度计(计划生成时): **${plan.temperature.label}**`, '',
    '| 代码 | 名称 | 昨收 | A卡触发 | 实际最高 | A触发了 | B卡低吸带 | 实际最低 | B触及了 | 收盘实际涨跌 |',
    '|---|---|---|---|---|---|---|---|---|---|'];
  const events = {};
  for (const a of alerts) events[a.code] = (events[a.code] || []).concat(a);
  const findCode = (arr, code, keys) => arr.find((s) => s.code === code);
  for (const it of plan.items) {
    const st = analyzed.stocks.find((s) => s.code === it.code);
    if (!st || st.error) { lines.push(`| ${it.code} | ${it.name} | ${it.prevClose} | - | 数据缺失 | - | - | - | - | - |`); continue; }
    const todayBar = st.barsTail?.length ? st.barsTail[st.barsTail.length - 1] : null;
    const hi = st.intraday ? st.intraday.high : todayBar?.high;
    const lo = st.intraday ? st.intraday.low : todayBar?.lo ?? todayBar?.low;
    const evs = events[it.code] || [];
    const aHit = evs.some((e) => e.kind === 'A·突破');
    const bHit = evs.some((e) => e.kind === 'B·低吸带');
    const inZone = isFinite(lo) && lo <= it.B.zone[1] && lo >= it.B.zone[0];
    const aCell = aHit ? '🔔监控确认' : (isFinite(hi) && hi >= it.A.trigger ? '√价差满足(监控未覆盖)' : '否');
    const bCell = bHit ? '🔔监控确认' : (inZone ? '√带内触及' : (isFinite(lo) && lo < it.B.stop ? '✗破位勿接' : '否'));
    lines.push(`| ${it.code} | ${it.name} | ${it.prevClose} | ≥${it.A.trigger} | ${(hi || 0).toFixed(2)} | ${aCell} | ${it.B.zone.join('~')} | ${(lo || 0).toFixed(2)} | ${bCell} | ${st.ds.pctToday.toFixed(2)}% |`);
  }
  lines.push('', '## 本日预警流水', '');
  if (!alerts.length) lines.push('(无)');
  for (const a of alerts) lines.push(`- ${a.ts} [${a.kind}] ${a.text}`);
  lines.push('', '> 口径提醒: 历史分时仅能取到当日；本复盘以当日盘口实际表现核对计划。', '', '⚠️ 价量推断非资金实测、趋势最强≠连板预期、仅供研究非投资建议。');
  return lines.join('\n');
}

module.exports = { marketContext, deepAnalyze, scanLeaders, buildReview, pickBoard };

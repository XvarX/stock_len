'use strict';
/**
 * pipeline.js — 编排核心: 市场上下文 / 单票深析 / 自动扫描龙头 / 复盘
 */
const CFG = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config.json'), 'utf-8'));
const { num } = require('./fetchers');
const S = require('./scoring');
const IND = require('./indicators');
const LU = require('./limitup');

const GENERIC_CONCEPTS = new Set(['融资融券', '深股通', '沪股通', '转融券标的', '标普道琼斯A股', '富时罗素概念', 'MSCI中国', '同花顺漂亮100', '机构重仓', '基金重仓']);
function isGenericConcept(c) {
  return GENERIC_CONCEPTS.has(c) || /成份股|成分股$/.test(c) || /^(上证50|沪深300|中证500|中证800|中证1000|科创50|创业板50|深证100)$/.test(c);
}

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
  const nonGeneric = cs.filter((c) => !isGenericConcept(c));
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
    const ds = IND.dailySummary(daily.bars, CFG.analysisWindow, code);
    try { const fl = await f.flowSeries([{ code, name: idt.name || code }]); ds.flow = fl[code] || null; } catch { ds.flow = null; }
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
        // 日K=今日时(盘中运行), ds.close即昨收; 日K截至昨日时(收盘后运行), 昨收需从涨跌幅反推
        const todayKey = require('./journal').dateKey().replace(/-/g, '');
        const isLiveDay = String(ctx.dataDate || '') < todayKey; // 日K落后于今天=今日为live交易日, 昨收=日K末根close
        const prevClose = isLiveDay ? ds.close : ds.close / (1 + ds.pctToday / 100);
        intra = IND.intradaySummary(m[code], isFinite(prevClose) ? prevClose : NaN);
      } catch {}
    }
    let boardStreak = null;
    try { boardStreak = LU.boardStreak(daily.bars, code); } catch {}
    stocks.push({ code, name: idt.name || code, swIndustry: idt.swIndustry, board: boardName, ds, score, stage, cards, intraday: intra, boardStreak, barsTail: daily.bars.slice(-CFG.analysisWindow) });
  }
  return { ctx, stocks };
}

/** --scan 自动找热度板块与候选龙头(涨幅主序, 主力净流入只作涨停并列时的破序键) */
async function scanLeaders(f) {
  const ctx = await marketContext(f);
  if (ctx.temp.overall === 'defend') return { ctx, halted: true, reason: '温度计防守档——今天整体休息，不产生候选池' };
  // ① 大涨/涨停+资金+流动性筛选。自然语言选股接口非确定性(同语句时而空时而全), 用逐级放宽的查询梯兜底
  const conds = CFG.scan.limitUpOnly
    ? ['今日涨停', `今日涨幅大于${CFG.scan.bigGainPct}%`] // 涨停口径全线失败时退回涨幅口径
    : [`今日涨幅大于${CFG.scan.bigGainPct}%`];
  const liqFull = `且主力净流入额大于0且总市值大于${CFG.scan.minMarketCapYi}亿且换手率大于${CFG.scan.minTurnoverRate}%`;
  const variants = [];
  for (const c0 of conds) variants.push(`${c0}${liqFull}的非ST股票`, `${c0}且主力净流入额大于0的非ST股票`, `${c0}的非ST股票`);
  let rows = [], usedQuery = '';
  for (const q of variants) {
    const r = await f.c.biz('stock', 'search_stocks', { query: q });
    const rs = r.ok && r.inner?.answer ? require('./ifind').parseMarkdownTable(String(r.inner.answer)) : [];
    const usable = rs.filter((x) => /^\d{6}$/.test(String(x.code || '').split('.')[0]) && (isFinite(num(x.pct)) || isFinite(num(x.flow))));
    if (usable.length >= 5) { rows = rs; usedQuery = q; break; }
    await new Promise((s) => setTimeout(s, 600));
  }
  const flowTb = (a, b) => (isFinite(b.flow) ? b.flow : -Infinity) - (isFinite(a.flow) ? a.flow : -Infinity);
  const rankCmp = CFG.scan.rankBy === 'flow'
    ? (a, b) => flowTb(a, b) || (isFinite(b.pct) ? b.pct : 0) - (isFinite(a.pct) ? a.pct : 0)  // 资金主序(涨停口径下即"谁的板更有钱")
    : (a, b) => (isFinite(b.pct) ? b.pct : 0) - (isFinite(a.pct) ? a.pct : 0) || flowTb(a, b); // 涨幅主序, 资金只破涨停并列
  const movers = rows
    .map((x) => ({ code: String(x.code || '').split('.')[0], name: x.name || '', pct: num(x.pct), flow: num(x.flow) }))
    .filter((x) => /^\d{6}$/.test(x.code) && (isFinite(x.pct) || isFinite(x.flow))) // 涨停口径的表无涨跌幅列, 有资金即可用
    .sort(rankCmp);
  if (!movers.length) return { ctx, halted: true, reason: `选股接口连续失败(尝试了${variants.length}种条件变体)——今晚跳过, 建议稍后重跑` };
  if (usedQuery !== variants[0]) console.log(`⚠ 主选股语句未命中, 已降级使用: ${usedQuery}`);
  // 情绪温度计专用: 无过滤全市场涨停总数(过滤口径会系统性低估热度)
  let marketLimitUpCount = movers.length;
  try {
    const rc = await f.c.biz('stock', 'search_stocks', { query: '今日涨停的非ST股票' });
    const rcRows = rc.ok && rc.inner?.answer ? require('./ifind').parseMarkdownTable(String(rc.inner.answer)) : [];
    if (rcRows.length) marketLimitUpCount = rcRows.length;
  } catch {}
  // ② 概念聚合(涨幅前probeN作聚类样本, 涨停并列由资金破序保证确定性)
  const probe = movers.slice(0, Math.min(movers.length, CFG.scan.probeN));
  const counts = {};
  const conceptsOf = {};
  for (const m of probe) {
    const idt = await f.identity(m.code);
    if (!idt.ok) continue;
    conceptsOf[m.code] = idt.concepts;
    for (const cpt of idt.concepts) {
      if (isGenericConcept(cpt)) continue;
      (counts[cpt] = counts[cpt] || new Set()).add(m.code);
    }
  }
  const boards = Object.entries(counts)
    .map(([name, set]) => ({ name, hits: set.size }))
    .filter((b) => b.hits >= 2) // 至少2只大涨股共有才算集群热点
    .sort((a, b) => b.hits - a.hits);
  if (!boards.length) return { ctx, halted: true, reason: '大涨股分散在各自孤立题材中，未形成≥2只共鸣的热点板块——情绪散点期，建议轻仓或观望' };
  const chosen = boards.slice(0, CFG.scan.boardTopN);
  // ③ 候选=热点板内个股, 沿用全局序(涨幅主序/资金破序), 取前candidateN深析
  const candidates = probe
    .filter((m) => (conceptsOf[m.code] || []).some((cpt) => chosen.some((b) => b.name === cpt)))
    .slice(0, CFG.scan.candidateN)
    .map((m) => m.code);
  // 主线纯度: 宽概念(成分股数百/千级)标签共现 ≠ 产业链同源, 自动降权标注
  const purity = [];
  for (const b of chosen) {
    const breadth = await f.sectorBreadth(b.name);
    purity.push({ name: b.name, breadth, tier: breadth == null ? '未知' : breadth <= 120 ? '窄/纯度高' : breadth <= 300 ? '中' : '宽/纯度存疑(需人工判定正宗性)' });
  }
  return { ctx, halted: false, boards: chosen.map((b) => ({ name: b.name, hits: b.hits, codes: [...(counts[b.name] || [])] })), purity, conceptsOf, rawGainCount: movers.length, marketLimitUpCount, probed: probe.length, candidates };
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
  lines.push('', '## 归因与策略迭代建议(启发式——仅供参考, 参数变更需你确认后才会应用)', '');
  let hinted = false;
  for (const it of plan.items) {
    const st = analyzed.stocks.find((s) => s.code === it.code);
    if (!st || st.error) continue;
    const todayBar = st.barsTail?.length ? st.barsTail[st.barsTail.length - 1] : null;
    const hi = st.intraday ? st.intraday.high : todayBar?.high;
    const lo = st.intraday ? st.intraday.low : todayBar?.low;
    const close = st.ds.close;
    const evs = (events[it.code] || []).map((e) => e.kind);
    const priceReached = isFinite(hi) && hi >= it.A.trigger;
    const aFired = evs.includes('A·突破');
    const infoBlock = evs.some((e) => String(e.kind || '').startsWith('INFO·'));
    if (aFired && close >= it.A.stop) { lines.push(`- ${it.code} ✅ A突破成立: 触发后收盘守住止损上方(收${close})`); hinted = true; }
    else if (aFired || (priceReached && isFinite(close) && close < it.A.stop)) { lines.push(`- ${it.code} ❌ 假突破: 价达${it.A.trigger}后回落至${close}(止损${it.A.stop}) → 本周若≥2次, 建议上调 confirm.aVolRatioMin(2→2.5)或严格 aRequireVwap`); hinted = true; }
    else if (!aFired && priceReached && infoBlock && close >= it.A.trigger) { lines.push(`- ${it.code} 😅 确认过严错过: 价达但确认未过, 收盘${close}仍站触发上方 → 可下调 aVolRatioMin 或关闭 marketConfirm`); hinted = true; }
    else if (!aFired && priceReached && infoBlock) { lines.push(`- ${it.code} 🛡 确认条件正确拦截假信号(价达${it.A.trigger}后回落至${close})`); hinted = true; }
    if (isFinite(lo) && lo <= it.B.zone[1] && lo >= it.B.zone[0] && close > it.B.zone[1]) { lines.push(`- ${it.code} ✅ B低吸成立: 带内${lo}回升收${close}`); hinted = true; }
    else if (isFinite(lo) && lo < it.B.stop) { lines.push(`- ${it.code} ❌ 低吸带被打穿(${lo}<${it.B.stop}) → 建议加严 bRequireStabilize 或整体下移低吸带`); hinted = true; }
    if (!hinted) lines.push(`- ${it.code} 未触及任何操作区(高${hi ?? '-'} 低${lo ?? '-'})`);
  }
  lines.push('', '> 迭代生效方式: 你回复确认后, 才由会话修改 config.json 对应参数并提交; 报告永不擅自改参。', '');
  lines.push('## 本日预警流水', '');
  if (!alerts.length) lines.push('(无)');
  for (const a of alerts) lines.push(`- ${a.ts} [${a.kind}] ${a.text}`);
  lines.push('', '> 口径提醒: 历史分时仅能取到当日；本复盘以当日盘口实际表现核对计划。', '', '⚠️ 价量推断非资金实测、趋势最强≠连板预期、仅供研究非投资建议。');
  return lines.join('\n');
}

module.exports = { marketContext, deepAnalyze, scanLeaders, buildReview, pickBoard };

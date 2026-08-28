#!/usr/bin/env node
'use strict';
/**
 * backtest.js — 分时重放回测(无前视)
 *
 * 原理: 今日分钟数据已定格。计划卡严格用 ≤昨日的日线切片计算(无未来数据),
 *       将今日分钟bar逐根喂入 gates 同套判定(每分钟只见≤t), 触发即以该分钟收盘价模拟买入,
 *       收盘价结算当日收益率(T+1浮盈口径)。
 * 对照组: 裸追(价格越20日高即买, 无确认链)——量化七关/六关的价值。
 *
 * 用法: node backtest.js [--min-pct 5] [--min-mv-yi 100] [--limit 100]
 */
const fs = require('fs');
const path = require('path');
const { IFind, parseMarkdownTable } = require('./lib/ifind');
const { Fetchers, num } = require('./lib/fetchers');
const S = require('./lib/scoring');
const IND = require('./lib/indicators');
const LU = require('./lib/limitup');
const G = require('./lib/gates');
const J = require('./lib/journal');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const GCONF = Object.assign({}, G.DEFAULTS, CFG.confirm || {});
const opt = { minPct: 5, minMvYi: 100, limit: 100 };
const args = process.argv.slice(2);
args.forEach((a, i) => {
  if (a === '--min-pct') opt.minPct = +args[i + 1];
  if (a === '--min-mv-yi') opt.minMvYi = +args[i + 1];
  if (a === '--limit') opt.limit = +args[i + 1];
});

const isNum = (v) => typeof v === 'number' && isFinite(v);
function agg(rets) {
  const r = rets.filter(isNum).sort((a, b) => a - b);
  if (!r.length) return { n: 0 };
  return {
    n: r.length,
    win: Math.round((r.filter((x) => x > 0).length / r.length) * 100),
    mean: +(r.reduce((s, x) => s + x, 0) / r.length).toFixed(2),
    med: +(r[Math.floor(r.length / 2)]).toFixed(2),
    min: +r[0].toFixed(2),
    max: +r[r.length - 1].toFixed(2),
  };
}

async function main() {
  const client = new IFind();
  const f = new Fetchers(client, null); // 回测数据不落缓存: 分时需全量, 日线批查自带当日键
  const todayKey = J.dateKey().replace(/-/g, '');
  const yesterdayKey = (() => { const d = new Date(Date.now() - 86400000); const p = (x) => String(x).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()); })();

  /* ① 选股: 市值+涨幅口径(查询梯兜底) */
  const conds = [
    `今日总市值大于${opt.minMvYi}亿且今日涨幅大于${opt.minPct}%的非ST股票`,
    `今日总市值大于${opt.minMvYi}亿且今日涨幅大于${opt.minPct}%的股票`,
  ];
  let rows = [];
  for (const q of conds) {
    const r = await client.biz('stock', 'search_stocks', { query: q });
    rows = r.ok && r.inner?.answer ? parseMarkdownTable(String(r.inner.answer)) : [];
    if (rows.length >= 5) break;
  }
  const movers = rows
    .map((x) => ({ code: String(x.code || '').split('.')[0], name: x.name || '', pct: num(x.pct), flow: num(x.flow) }))
    .filter((x) => /^\d{6}$/.test(x.code) && (isFinite(x.pct) || isFinite(x.flow)))
    .sort((a, b) => (isFinite(b.flow) ? b.flow : -1e9) - (isFinite(a.flow) ? a.flow : -1e9))
    .slice(0, opt.limit);
  if (!movers.length) { console.log('股票池为空——检查口径或配额'); process.exit(0); }
  console.log(`股票池: ${movers.length} 只 (市值≥${opt.minMvYi}亿, 涨幅≥${opt.minPct}%)`);

  /* ② 数据: 原始数据集落盘复用(参数扫描零配额) */
  const rawFile = path.join(__dirname, 'cache', `backtest_raw_${J.dateKey()}.json`);
  let dataset;
  if (args.includes('--offline') && fs.existsSync(rawFile)) {
    dataset = JSON.parse(fs.readFileSync(rawFile, 'utf-8'));
    console.log('[offline] 复用已落盘数据集');
  } else {
    console.log('拉取日线(4只/包)...');
    const dailyAll = await f.dailyBatch(movers.map((m) => m.code), 32);
    console.log('拉取今日分时(10只/包)...');
    const codes = movers.map((m) => m.code);
    const intradayAll = {};
    for (let i = 0; i < codes.length; i += 10) {
      try { Object.assign(intradayAll, await f.intraday(codes.slice(i, i + 10), { fresh: true })); }
      catch (e) { console.log('分时chunk失败:', e.message); }
    }
    dataset = { dailyAll, intradayAll };
    fs.mkdirSync(path.join(__dirname, 'cache'), { recursive: true });
    fs.writeFileSync(rawFile, JSON.stringify(dataset));
  }
  const dailyAll = dataset.dailyAll, intradayAll = dataset.intradayAll;

  /* ③ 大盘分时(市场门逐分钟重放) */
  let idxPrev = { SH: null, CYB: null }, idxBars = { SH: [], CYB: [] };
  try {
    const snap = await f.benchmarkSnapshot();
    if (snap['上证指数'] && isFinite(snap['上证指数'].latest)) idxPrev.SH = snap['上证指数'].latest / (1 + snap['上证指数'].pct / 100);
    if (snap['创业板指'] && isFinite(snap['创业板指'].latest)) idxPrev.CYB = snap['创业板指'].latest / (1 + snap['创业板指'].pct / 100);
    const r = await client.biz('index', 'index_highfreq_quotes', { symbols: '上证指数,创业板指', indicators: '收盘价', data_mode: 'highfreq', interval: 1 });
    if (r.ok && r.inner?.tables) {
      const head = r.inner.tables[0].map((h) => (h.includes('简称') ? 'name' : h === 'time' ? 'time' : 'close'));
      const sym = r.inner.sympolMap || {};
      for (const cells of r.inner.tables.slice(1)) {
        const o = Object.fromEntries(head.map((h, i2) => [h, cells[i2] ?? '']));
        const nm = sym[o.code || ''] || o.name || '';
        const bar = { time: String(o.time || '').slice(-5), close: parseFloat(o.close) };
        if (!bar.time || !isFinite(bar.close)) continue;
        if (/上证/.test(nm)) idxBars.SH.push(bar); else if (/创业/.test(nm)) idxBars.CYB.push(bar);
      }
    }
  } catch (e) { console.log('指数分时不可用, 大盘门退化放行:', e.message); }
  const marketOkAt = (t) => {
    if (!idxBars.SH.length && !idxBars.CYB.length) return undefined; // 退化放行
    const pctAt = (arr, prev) => {
      if (!prev || !arr.length) return null;
      const b = arr.find((x) => x.time >= t) || arr[arr.length - 1];
      return (b.close / prev - 1) * 100;
    };
    const a = pctAt(idxBars.SH, idxPrev.SH), b = pctAt(idxBars.CYB, idxPrev.CYB);
    return Math.max(isFinite(a) ? a : -99, isFinite(b) ? b : -99) >= (isFinite(GCONF.marketPctMin) ? GCONF.marketPctMin : 0);
  };

  /* ④ 逐票: 计划(≤昨日) → 逐分钟重放(追深上限可扫描) */
  function replayPool(chaseCap) {
    const conf = Object.assign({}, GCONF, { aMaxChasePct: chaseCap });
    const trades = [], naiveTrades = [], skipped = [], naiveDiag = [];
  for (const u of movers) {
    const barsAll = dailyAll[u.code] || [];
    const barsPlan = barsAll.filter((b) => String(b.date) <= yesterdayKey);
    const tb = intradayAll[u.code] || [];
    if (barsPlan.length < 12) { skipped.push({ code: u.code, reason: `日线样本不足(${barsPlan.length})` }); continue; }
    if (tb.length < 10) { skipped.push({ code: u.code, reason: `分时不足(${tb.length})` }); continue; }

    const ds = IND.dailySummary(barsPlan, CFG.analysisWindow, u.code);
    const streak = LU.boardStreak(barsPlan, u.code);
    const cards = S.buildCards(u.code, u.name, ds, { overall: 'normal', label: '正常' }, { stage: 'mainup' });
    const item = { code: u.code, name: u.name, A: cards.A, B: cards.B, prevClose: ds.close, flow: null }; // 资金门退化: 回放无当日逐分钟净流入
    const naiveHi = Math.max(...barsPlan.slice(-20).map((b) => b.high));
    const layer = u.pct >= IND.limitUpPct(u.code) - 0.2 ? '涨停层' : '5-10%层';

    let naiveEntry = null;
    let entry = null; // {kind,price,time}
    let maxDD = 0, riskTouch = false, sealWait = false;
    const lastFails = {};
    for (let i = 0; i < tb.length; i++) {
      const bar = tb[i];
      const p = bar.close;
      const t = String(bar.time).slice(-5);
      const barsSoFar = tb.slice(0, i + 1);

      // 裸追对照 + 诊断: 同一分钟A卡卡在哪关
      if (!naiveEntry && p >= naiveHi) {
        naiveEntry = { kind: '裸追', price: p, time: t };
        if (item.A.status === '待触发') {
          const r = G.evaluateA({ item, price: p, bars: barsSoFar, conf, marketOk: marketOkAt(t), sectorOk: true });
          naiveDiag.push({ code: u.code, failed: r.failed.join('/') || '全过(却未触发?)' });
        } else {
          naiveDiag.push({ code: u.code, failed: 'A卡状态:' + item.A.status });
        }
      }

      // A卡
      if (!entry && item.A.status === '待触发' && p >= item.A.trigger) {
        const r = G.evaluateA({ item, price: p, bars: barsSoFar, conf: GCONF, marketOk: marketOkAt(t), sectorOk: true }); // sector门退化放行(板块真值非逐分钟可得)
        if (r.pass) { entry = { kind: 'A', price: p, time: t }; }
        else if (r.failed.length === 1 && r.failed[0] === '未封板') { sealWait = true; } // 封板中等待开板
        else lastFails.A = r.failed;
      }
      // B卡(未被A占先)
      if (!entry && item.B.status === '待触发' && p >= item.B.zone[0] && p <= item.B.zone[1]) {
        const r = G.evaluateB({ item, price: p, openPrice: tb[0].open, bars: barsSoFar, conf: GCONF, marketOk: marketOkAt(t), sectorOk: true });
        if (r.pass) entry = { kind: 'B', price: p, time: t };
        else lastFails.B = r.failed;
      }
      // 持仓跟踪: 最大浮亏 + 风控线触及(T+1不可卖, 仅记录)
      if (entry) {
        maxDD = Math.min(maxDD, p / entry.price - 1);
        if (p <= item.B.stop) riskTouch = true;
      }
    }
    const closeP = tb[tb.length - 1].close;
    const rec = {
      code: u.code, name: u.name, layer, prevClose: ds.close, boards: streak.boards,
      triggerA: item.A.trigger, triggerB: item.B.zone, naiveHi,
      lastFails,
    };
    if (entry) {
      const dayReturn = (closeP / entry.price - 1) * 100;
      trades.push({ ...rec, ...entry, closeP, dayReturn: +dayReturn.toFixed(2), maxDD: +(maxDD * 100).toFixed(2), riskTouch });
    } else {
      trades.push({ ...rec, noEntry: true, sealWait });
    }
    if (naiveEntry) {
      naiveTrades.push({ code: u.code, ...naiveEntry, closeP, dayReturn: +((closeP / naiveEntry.price - 1) * 100).toFixed(2) });
    }
    }
    return { trades, naiveTrades, skipped, naiveDiag };
  }

  // 追深参数扫描(纯本地计算)
  const sweepRows = [];
  let naiveAgg = null;
  for (const cap of [2, 5, 10, 999]) {
    const rp = replayPool(cap);
    const a = agg(rp.trades.filter((t) => t.entry && t.kind === 'A').map((t) => t.dayReturn));
    const b = agg(rp.trades.filter((t) => t.entry && t.kind === 'B').map((t) => t.dayReturn));
    const all = agg(rp.trades.filter((t) => t.entry).map((t) => t.dayReturn));
    if (!naiveAgg) naiveAgg = agg(rp.naiveTrades.map((t) => t.dayReturn));
    sweepRows.push({ cap: cap === 999 ? '不设限' : cap + '%', aSig: a.n || 0, bSig: b.n || 0, allSig: all.n || 0, allWin: all.win ?? '-', allMean: all.mean ?? '-', allMin: all.min ?? '-', naiveMean: naiveAgg.mean ?? '-' });
  }

  /* ⑤ 统计与报告: 追深参数扫描(纯本地计算) + 明细(标准档2%) */
  const sweep = [];
  let detailRp = null, naive = null;
  for (const cap of [2, 5, 10, 999]) {
    const rp = replayPool(cap);
    if (cap === 2) detailRp = rp;
    const a = agg(rp.trades.filter((t) => t.entry && t.kind === 'A').map((t) => t.dayReturn));
    const b = agg(rp.trades.filter((t) => t.entry && t.kind === 'B').map((t) => t.dayReturn));
    const all = agg(rp.trades.filter((t) => t.entry).map((t) => t.dayReturn));
    naive = agg(rp.naiveTrades.map((t) => t.dayReturn));
    sweep.push({ cap: cap === 999 ? '不设限' : cap + '%', aSig: a.n || 0, bSig: b.n || 0, allSig: all.n || 0, allWin: all.win ?? '-', allMean: all.mean ?? '-', allMin: all.min ?? '-', allMax: all.max ?? '-' });
  }
  const detail = detailRp;
  const entries = detail.trades.filter((t) => t.entry);
  const strat = agg(entries.map((t) => t.dayReturn));
  const sealBlocked = detail.trades.filter((t) => t.sealWait && !t.entry).length;
  const stratLimit = agg(entries.filter((t) => t.layer === '涨停层').map((t) => t.dayReturn));
  const stratMid = agg(entries.filter((t) => t.layer === '5-10%层').map((t) => t.dayReturn));
  const skipped = detail.skipped, trades = detail.trades;

  const L = [];
  L.push(`# 分时重放回测 · ${J.dateKey()}`);
  L.push(`股票池: 市值≥${opt.minMvYi}亿且涨幅≥${opt.minPct}% (上限${opt.limit}) | 实际入池 ${movers.length} 只 | 无前视: 计划卡仅用≤${yesterdayKey}数据`);
  L.push('');
  L.push('## 追深上限参数扫描(策略) + 裸追对照');
  L.push('| 口径 | 信号数 | 当日胜率 | 均值收益% | 最差% | 最好% |');
  L.push('|---|---|---|---|---|---|');
  for (const r of sweep) L.push(`| 策略(追深上限${r.cap}) | ${r.allSig} | ${r.allWin}% | ${r.allMean} | ${r.allMin} | ${r.allMax} |`);
  L.push(`| 裸追(无确认链) | ${naive.n} | ${naive.win}% | ${naive.mean} | ${naive.min} | ${naive.max} |`);
  L.push(`\n分层(标准档 追深2%): 涨停层 ${stratLimit.n}笔 均${stratLimit.mean ?? '-'}% | 5~10%层 ${stratMid.n}笔 均${stratMid.mean ?? '-'}%`);
  L.push('');
  L.push('## 逐票明细(标准档 策略触发)');
  L.push('| 代码 | 名称 | 层 | 连板 | 卡 | 触发时刻 | 买入价 | 收盘 | 当日收益% | 买入后最大浮亏% | 触风控线 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const t of entries) {
    L.push(`| ${t.code} | ${t.name} | ${t.layer} | ${t.boards} | ${t.kind} | ${t.time} | ${t.price} | ${t.closeP} | ${t.dayReturn} | ${t.maxDD} | ${t.riskTouch ? '⚠是' : '否'} |`);
  }
  if (sealBlocked) L.push(`\n封板等待不可成交: ${sealBlocked} 例(涨停封死中不排队买入)`);
  L.push('\n## 诊断: 裸追触发分钟时A卡卡在哪关');
  for (const d of (detailRp ? detailRp.naiveDiag : [])) L.push(`- ${d.code}: ${d.failed}`);
  L.push('\n## 未触发/跳过');
  for (const s of skipped) L.push(`- ${s.code}: ${s.reason}`);
  for (const t of trades.filter((x) => x.noEntry)) L.push(`- ${t.code} ${t.name}: 全日未过确认链${t.sealWait ? '(封板等待中)' : ''}${t.lastFails.A ? ' 最近A未过关:' + t.lastFails.A.join('/') : ''}`);
  L.push('\n## 局限声明');
  L.push('- 单日样本, 仅代表今日市况(情绪定位见当日scan); 理想成交无滑点/手续费; 分钟收盘价近似快照价');
  L.push('- 资金门退化: 回放中"当日主力净流入"属未来数据, 改用放行并在实盘由实时口径补位');
  L.push('- 板块门退化放行(板块真值非逐分钟可得); T+1当日浮盈不可兑现, 最大浮亏为持仓压力指标');
  L.push('- 裸追对照触发条件与策略同池同窗口, 差异仅确认链');

  const dir = path.join(__dirname, 'reports', 'backtest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${J.dateKey()}_回测.md`), L.join('\n'), 'utf-8');
  fs.writeFileSync(path.join(dir, `${J.dateKey()}_回测.json`), JSON.stringify({ version: 'stock-lens-backtest/1', date: J.dateKey(), pool: movers.length, sweep, strategy: strat, naive, stratLimit, stratMid, trades: detail.trades, skipped: detail.skipped }, null, 2), 'utf-8');
  console.log('\n' + L.join('\n'));
  console.log('\n[offline] 可用 --offline 复用今日数据集做零配额参数扫描');
  console.log('✓ 回测报告: reports/backtest/');
}

main().catch((e) => { console.error('✗', e.stack || e.message); process.exit(1); });

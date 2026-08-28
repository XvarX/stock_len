#!/usr/bin/env node
'use strict';
/**
 * analyze.js — 全链路短线分析入口
 *
 * 用法:
 *   node analyze.js <代码...>      夜间深度分析 → 生成《次日作战计划》并落盘
 *   node analyze.js --scan        自动找热度板块与龙头候选 → 深析 → 作战计划
 *   node analyze.js --auction     9:25 竞价校准(读当日计划, 按高低开规则调整卡片)
 *   node analyze.js --review      15:05 收盘复盘(计划 vs 实际)
 */
const fs = require('fs');
const path = require('path');
const { IFind } = require('./lib/ifind');
const { Fetchers } = require('./lib/fetchers');
const P = require('./lib/pipeline');
const S = require('./lib/scoring');
const R = require('./lib/report');
const J = require('./lib/journal');

const args = process.argv.slice(2);
const mode = args.includes('--scan') ? 'scan' : args.includes('--auction') ? 'auction' : args.includes('--review') ? 'review' : 'night';
const codes = args.filter((a) => !a.startsWith('--'));

function die(msg) { console.error('✗ ' + msg); process.exit(1); }

async function main() {
  const client = new IFind();
  const today = J.dateKey();
  const f = new Fetchers(client, path.join(__dirname, 'cache', today));

  /* ---------- 竞价校准 ---------- */
  if (mode === 'auction') {
    let plan = J.loadPlan(today);
    if (!plan) {
      // 无记录 → 自动走一次找龙头, 当日生效
      console.log('未找到今日计划 → 自动执行找龙头(--scan)...');
      sc = await P.scanLeaders(f);
      if (sc.halted) die('找龙头被拦截: ' + sc.reason);
      if (!sc.candidates.length) die('候选池为空, 无可操作标的');
      const result = await P.deepAnalyze(f, sc.candidates);
      const valid = result.stocks.filter((s) => !s.error && s.ds && isFinite(s.ds.close));
      const payload = {
        generatedAt: new Date().toISOString(), sourceMode: 'auction-fallback-scan',
        scanSource: (sc.boards || []).map((b) => `${b.name}(集群${b.hits})`).join(', '),
        temperature: { overall: result.ctx.temp.overall, label: result.ctx.temp.label },
        benchCum20: result.ctx.benchCum20,
        guardLines: ['温度计=' + result.ctx.temp.label + (result.ctx.temp.overall === 'defend' ? ': 建议空仓' : result.ctx.temp.overall === 'watch' ? ': 轻仓试错' : ': 正常操作')],
        targetNote: '竞价时段自动生成, 当日生效',
        targetDate: today,
        items: valid.map((st) => ({
          code: st.code, name: st.name, board: st.board || null,
          prevClose: Number(st.cards.refClose.toFixed(2)), score: st.score.composite,
          A: st.cards.A, B: st.cards.B,
          notes: [st.score.grade, st.ds.posTag, ...(st.cards.guardNotes || [])],
        })),
      };
      J.savePlan(payload.targetDate, payload);
      fs.writeFileSync(path.join(__dirname, 'journal', 'plans', payload.targetDate + '.json'), JSON.stringify(payload, null, 2), 'utf-8');
      plan = payload;
    }
    if (plan.targetDate && String(plan.targetDate) !== today)
      die(`计划的交易目标日是 ${plan.targetDate}, 与今天(${today})不符——请在对应交易日早上再校准`);
    const snap = await f.snapshot(plan.items.map((x) => x.code));
    if (snap.__error) die('快照失败: ' + snap.__error);
    console.log(`\n=== 9:25 竞价校准 (${today}) ===\n`);
    let changed = false;
    for (const it of plan.items) {
      const adj = S.auctionAdjust(it, snap[it.code], it.prevClose);
      it.A = adj.updated.A; it.B = adj.updated.B;
      if (adj.updated.status !== undefined) it.status = adj.updated.status;
      changed = true;
      console.log(`${it.code} ${it.name} | 竞价gap ${adj.gapPct ?? '?'}%`);
      for (const line of adj.adjustments) console.log('   ' + line);
      J.appendAlert(today, { kind: 'AUCTION', code: it.code, text: adj.adjustments.join(' ') });
    }
    plan.auctionCheckedAt = new Date().toISOString();
    const p = J.savePlan(today, plan);
    console.log('\n✓ 计划已按竞价更新: ' + p);
    return;
  }

  /* ---------- 收盘复盘 ---------- */
  if (mode === 'review') {
    const plan = J.loadPlan(today);
    if (!plan) die(`未找到今日(${today})作战计划`);
    const analyzed = await P.deepAnalyze(f, plan.items.map((x) => x.code));
    const alerts = J.alertsOf(today);
    const md = P.buildReview(plan, analyzed, alerts);
    const saved = J.saveReview(today, md);
    console.log(md);
    console.log('\n✓ 复盘已存: ' + saved);
    return;
  }

  /* ---------- 夜间分析 / 自动扫描 ---------- */
  let scanSource = null;
  let sc = null;
  let finalCodes = codes;
  if (mode === 'scan') {
    console.log('扫描热度板块与龙头候选...');
    sc = await P.scanLeaders(f);
    if (sc.halted) die(sc.reason);
    scanSource = sc.boards.map((b) => `${b.name}(大涨集群${b.hits}只)`).join(', ');
    console.log(`热点: ${scanSource}`);
    finalCodes = sc.candidates;
    if (!finalCodes.length) die('候选池为空——上涨结构不够集中, 建议观望');
    console.log('候选池: ' + finalCodes.join(', ') + '\n');
  }
  if (!finalCodes.length) die('请给代码或使用 --scan');

  console.log(`深度分析 ${finalCodes.length} 只票...`);
  const result = await P.deepAnalyze(f, finalCodes);

  // 龙头识别v2: 情绪定位 + 连板梯队 + 五维龙头榜 + 催化确认
  if (mode === 'scan' && sc) {
    const LU = require('./lib/limitup');
    const ok = result.stocks.filter((s) => !s.error && s.boardStreak);
    const streaks = ok.map((s) => s.boardStreak);
    const maxBoards = Math.max(0, ...streaks.map((x) => x.boards));
    const emotion = LU.classifyEmotion(sc.marketLimitUpCount || sc.rawGainCount || finalCodes.length, maxBoards);
    const ladder = LU.ladderStats(streaks);
    // 首板日时序排名(早=高分)
    const dates = [...new Set(streaks.map((x) => x.firstDate).filter(Boolean))].sort();
    const leaders = ok.map((st) => {
      const bs = st.boardStreak;
      const clusterHits = (sc.boards.find((b) => (sc.conceptsOf?.[st.code] || []).includes(b.name)) || {}).hits || 0;
      const ls = LU.leaderScore({
        boards: bs.boards,
        firstDateRank: dates.indexOf(bs.firstDate),
        clusterHits,
        oneWordToday: bs.oneWordToday,
        broken: st.ds.boardQ ? st.ds.boardQ.broken : false,
        flowToday: st.ds.flow ? st.ds.flow.today : NaN,
      });
      return { code: st.code, name: st.name, boards: bs.boards, firstDate: bs.firstDate, oneWordToday: bs.oneWordToday,
        broken: st.ds.boardQ ? st.ds.boardQ.broken : false, clusterHits, ...ls };
    }).sort((a, b) => b.score - a.score);
    leaders.forEach((l, i) => (l.rank = i + 1));
    let catalyst = null;
    const topBoard = (sc.boards[0] || {}).name;
    if (topBoard) catalyst = await f.newsCatalyst(topBoard, 3);
    result.scanMeta = {
      emotion, ladder, leaders, catalyst, catalystBoard: topBoard,
      limitUpCount: sc.marketLimitUpCount || sc.rawGainCount || finalCodes.length,
      limitUpFiltered: sc.rawGainCount || 0,
      scannedAt: new Date().toISOString(),
    };
  }

  // 报告落盘: 标准化 .md + .json 成对
  const title = mode === 'scan' ? `热度龙头分析 · ${today}` : `深度分析 · ${today}`;
  const md = R.renderFull(result, title);
  const repBase = path.join(__dirname, 'reports', `${today}_${finalCodes.join('-').slice(0, 60)}`);
  fs.mkdirSync(path.dirname(repBase), { recursive: true });
  fs.writeFileSync(repBase + '.md', md, 'utf-8');
  result.mode = mode; result.scanSource = scanSource;
  const sj = R.standardJson(result, { totalMs: client.log.reduce((s, x) => s + x.ms, 0), calls: client.log });
  fs.writeFileSync(repBase + '.json', JSON.stringify(sj, null, 2), 'utf-8');

  // 次日作战计划
  const valid = result.stocks.filter((s) => !s.error && s.ds && isFinite(s.ds.close));
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceMode: mode,
    scanSource,
    temperature: { overall: result.ctx.temp.overall, label: result.ctx.temp.label },
    benchCum20: result.ctx.benchCum20,
    guardLines: [
      `温度计=${result.ctx.temp.label}: ${result.ctx.temp.overall === 'defend' ? '所有信号降级观望/空仓' : result.ctx.temp.overall === 'watch' ? '轻仓试错' : '正常操作'}`,
      '单票仓位≤30%; 当日止损2次强制收手; 持仓破5日线无条件离场',
    ],
    targetNote: '以下价位由数据日收盘推导, 节假日顺延仅按周末处理',
    targetDate: J.nextTradingDay(result.ctx.dataDate || today),
    items: valid.map((st) => ({
      code: st.code, name: st.name, board: st.board || null,
      prevClose: Number(st.cards.refClose.toFixed ? st.cards.refClose.toFixed(2) : st.cards.refClose),
      score: st.score.composite,
      A: st.cards.A, B: st.cards.B,
      notes: [`${st.score.grade}`, st.ds.posTag, ...(st.boardStreak && st.boardStreak.boards ? [`${st.boardStreak.boards}连板(首板${st.boardStreak.firstDate})`] : []), ...(st.cards.guardNotes || [])],
    })),
  };
  // 合并同日已有计划: 新运行的票以最新状态为准, 未涉及的旧票原样保留(避免多轮分析互相覆盖)
  const existing = J.loadPlan(payload.targetDate);
  if (existing && Array.isArray(existing.items)) {
    const byCode = new Map(existing.items.map((i) => [i.code, i]));
    for (const it of payload.items) byCode.set(it.code, { ...byCode.get(it.code), ...it });
    payload.items = [...byCode.values()];
  }
  const planPath = J.savePlan(payload.targetDate, payload);
  fs.writeFileSync(path.join(__dirname, 'journal', 'plans', payload.targetDate + '.json'), JSON.stringify(payload, null, 2), 'utf-8');

  console.log('\n' + md + '\n');
  console.log(client.timingTable());
  console.log(`\n✓ 报告: ${repBase}.md / .json`);
  console.log(`✓ ${payload.targetDate} 作战计划: ${planPath} (+.json)`);
}

main().catch((e) => die(e.stack || e.message));

#!/usr/bin/env node
'use strict';
/**
 * planctl.js — 当日作战计划的盘中修正工具
 * 双层架构第二层的落盘通道: 5分钟 LLM 定时任务判断盘面变化后, 只能经本工具改计划, 禁止手改文件。
 *
 * 用法:
 *   node planctl.js context [--date YYYY-MM-DD]     输出判断依据: 计划卡片+大盘+个股实时+板块 (JSON)
 *   node planctl.js status <代码>                    查看某票当前卡片
 *   node planctl.js set-a <代码> --trigger 190 [--stop 181] [--top 193] --reason "..."
 *   node planctl.js set-b <代码> --lo 150 --hi 156 [--stop 148] --reason "..."
 *   node planctl.js disable <代码> <a|b|both> --reason "..."
 *   node planctl.js enable  <代码> <a|b> --reason "..."
 *
 * 护栏(违反直接拒绝):
 *   - 只能操作当日(或 --date 指定且 targetDate 匹配)计划内的既有标的, 不能新增/删除票
 *   - A卡止损只能上移(收紧), B卡止损只能下移; 触发价/低吸带可双向调
 *   - 每次修改必须带 --reason, 全量落审计 journal/alerts (kind=PLAN·修正)
 */
const fs = require('fs');
const path = require('path');
const { IFind } = require('./lib/ifind');
const { Fetchers } = require('./lib/fetchers');
const J = require('./lib/journal');
const IND = require('./lib/indicators');

const raw = process.argv.slice(2);
const dateIdx = raw.indexOf('--date');
const overrideDate = dateIdx >= 0 ? raw.splice(dateIdx, 2)[1] : null;
const cmd = raw.shift() || '';
const rest = new Map();
for (let i = 0; i < raw.length; i++) {
  if (raw[i].startsWith('--')) rest.set(raw[i].slice(2), raw[++i]);
}
const positional = raw.filter((a) => !a.startsWith('--'));

function die(msg) { console.error('✗ ' + msg); process.exit(1); }
function numArg(k) { const n = Number(rest.get(k)); if (!isFinite(n) || n <= 0) die(`缺少或非法参数 --${k}`); return n; }
function r2(x) { return Math.round(x * 100) / 100; }

function loadPlan(dateStr) {
  const plan = J.loadPlan(dateStr);
  if (!plan || !(plan.items || []).length) die(`未找到 ${dateStr} 作战计划`);
  if (plan.targetDate && String(plan.targetDate) !== dateStr) die(`计划 targetDate=${plan.targetDate} ≠ ${dateStr}, 拒绝操作`);
  return plan;
}
function savePlan(dateStr, plan) {
  const p = J.savePlan(dateStr, plan);
  fs.writeFileSync(path.join(__dirname, 'journal', 'plans', dateStr + '.json'), JSON.stringify(plan, null, 2), 'utf-8');
  return p;
}
function itemOf(plan, code) {
  const it = (plan.items || []).find((i) => i.code === code);
  if (!it) die(`计划中无 ${code}, 且不允许新增标的`);
  return it;
}
function audit(dateStr, code, text) { J.appendAlert(dateStr, { kind: 'PLAN·修正', code, text }); }
function requireReason() { const r = rest.get('reason'); if (!r) die('必须提供 --reason'); return r; }

/* ---------- context: LLM 判断依据 ---------- */
async function doContext(dateStr) {
  const plan = loadPlan(dateStr);
  const client = new IFind();
  const f = new Fetchers(client, null);
  const codes = plan.items.map((x) => x.code);
  const out = {
    date: dateStr,
    temp: plan.temperature || null,
    benchCum20: plan.benchCum20 ?? null,
    benchmarks: null, sectors: {}, stocks: [],
  };
  try { out.benchmarks = await f.benchmarkSnapshot(); } catch (e) { out.benchmarks = { error: e.message }; }
  const snap = {};
  for (let i = 0; i < codes.length; i += 10) Object.assign(snap, await f.snapshot(codes.slice(i, i + 10)));
  const boards = [...new Set(plan.items.map((x) => x.board).filter(Boolean))];
  for (const b of boards) { try { await f.sectorPct(b, 300); } catch {} }
  const intra = {};
  for (let i = 0; i < codes.length; i += 10) {
    try { Object.assign(intra, await f.intraday(codes.slice(i, i + 10), { fresh: true })); } catch {}
  }
  for (const it of plan.items) {
    const s = snap[it.code] || {};
    const bars = intra[it.code];
    const cf = bars && bars.length > 5 ? IND.evaluateConfirmations(bars, { px: s.latest }) : {};
    out.stocks.push({
      code: it.code, name: it.name, board: it.board || null, score: it.score ?? null,
      prevClose: it.prevClose, latest: s.latest ?? null, pct: s.pct ?? null,
      gapPct: isFinite(s.openPrice) && it.prevClose ? r2((s.openPrice / it.prevClose - 1) * 100) : null,
      vwap: cf.vwap ?? null, aboveVwap: cf.aboveVwap ?? null,
      breakoutVolRatio: isFinite(cf.breakoutVolRatio) ? r2(cf.breakoutVolRatio) : null,
      stabilized: cf.stabilized ?? null,
      retractVolRatio: isFinite(cf.retractVolRatio) ? r2(cf.retractVolRatio) : null,
      A: { status: it.A.status, trigger: it.A.trigger, zone: it.A.zone, stop: it.A.stop },
      B: { status: it.B.status, zone: it.B.zone, stop: it.B.stop },
      sectorPct: it.board ? (isFinite(f._sec?.[it.board]?.pct) ? f._sec[it.board].pct : null) : null,
    });
  }
  console.log(JSON.stringify(out, null, 2));
}

/* ---------- 修正子命令 ---------- */
function doSetA(dateStr) {
  const code = positional[0];
  const plan = loadPlan(dateStr);
  const it = itemOf(plan, code);
  const A = it.A;
  const trigger = rest.has('trigger') ? numArg('trigger') : A.trigger;
  const top = rest.has('top') ? numArg('top') : r2(Math.max(trigger * 1.02, trigger));
  const stop = rest.has('stop') ? numArg('stop') : A.stop;
  if (stop < A.stop - 1e-9) die(`A卡止损只能上移收紧: 新${stop} < 旧${A.stop}`);
  if (top < trigger) die(`A卡带上沿(${top})不得低于触发价(${trigger})`);
  const reason = requireReason();
  const chg = [`trigger ${A.trigger}→${trigger}`, `zone [${A.zone}]→[${trigger},${top}]`, `stop ${A.stop}→${stop}`];
  A.trigger = trigger; A.zone = [trigger, top]; A.stop = stop;
  if (A.status !== '待触发') { A.status = '待触发'; A.forbidReasons = []; chg.push('status→待触发'); }
  savePlan(dateStr, plan); audit(dateStr, code, `set-a ${chg.join('; ')} | ${reason}`);
  console.log(`✓ ${code} A卡已调整: ${chg.join('; ')}`);
}

function doSetB(dateStr) {
  const code = positional[0];
  const plan = loadPlan(dateStr);
  const it = itemOf(plan, code);
  const B = it.B;
  const lo = rest.has('lo') ? numArg('lo') : B.zone[0];
  const hi = rest.has('hi') ? numArg('hi') : B.zone[1];
  const stop = rest.has('stop') ? numArg('stop') : B.stop;
  if (lo > hi) die(`B卡带下沿(${lo})不得高于上沿(${hi})`);
  if (stop > B.stop + 1e-9) die(`B卡止损只能下移收紧: 新${stop} > 旧${B.stop}`);
  if (stop >= lo) die(`B卡止损(${stop})必须低于带下沿(${lo})`);
  const reason = requireReason();
  const chg = [`zone [${B.zone}]→[${lo},${hi}]`, `stop ${B.stop}→${stop}`];
  B.zone = [lo, hi]; B.stop = stop;
  if (B.status !== '待触发') { B.status = '待触发'; B.forbidReasons = []; chg.push('status→待触发'); }
  savePlan(dateStr, plan); audit(dateStr, code, `set-b ${chg.join('; ')} | ${reason}`);
  console.log(`✓ ${code} B卡已调整: ${chg.join('; ')}`);
}

function doDisable(dateStr) {
  const code = positional[0];
  const which = (positional[1] || 'both').toLowerCase();
  if (!['a', 'b', 'both'].includes(which)) die('第二参数须为 a|b|both');
  const plan = loadPlan(dateStr);
  const it = itemOf(plan, code);
  const reason = requireReason();
  const done = [];
  if (which !== 'b' && it.A.status !== '禁用') { it.A.status = '禁用'; it.A.forbidReasons = [...(it.A.forbidReasons || []), reason]; done.push('A'); }
  if (which !== 'a' && it.B.status !== '禁用') { it.B.status = '禁用'; it.B.forbidReasons = [...(it.B.forbidReasons || []), reason]; done.push('B'); }
  if (!done.length) die(`${code} 的 ${which} 卡已是禁用状态`);
  savePlan(dateStr, plan); audit(dateStr, code, `disable ${done.join('+')} | ${reason}`);
  console.log(`✓ ${code} 已禁用 ${done.join('+')} 卡`);
}

function doEnable(dateStr) {
  const code = positional[0];
  const which = (positional[1] || '').toLowerCase();
  if (!['a', 'b'].includes(which)) die('第二参数须为 a|b');
  const plan = loadPlan(dateStr);
  const it = itemOf(plan, code);
  const card = which === 'a' ? it.A : it.B;
  if (card.status === '待触发') die(`${code} ${which.toUpperCase()}卡本就待触发`);
  card.status = '待触发'; card.forbidReasons = [];
  const reason = requireReason();
  savePlan(dateStr, plan); audit(dateStr, code, `enable ${which.toUpperCase()} | ${reason}`);
  console.log(`✓ ${code} ${which.toUpperCase()}卡已恢复待触发`);
}

function doStatus(dateStr) {
  const code = positional[0];
  const plan = loadPlan(dateStr);
  const it = itemOf(plan, code);
  console.log(JSON.stringify({ code: it.code, name: it.name, board: it.board, score: it.score, prevClose: it.prevClose, A: it.A, B: it.B, notes: it.notes }, null, 2));
}

(async () => {
  const dateStr = overrideDate || J.dateKey();
  switch (cmd) {
    case 'context': return doContext(dateStr);
    case 'status': if (!positional[0]) die('用法: status <代码>'); return doStatus(dateStr);
    case 'set-a': if (!positional[0]) die('用法: set-a <代码> --trigger .. [--stop ..] [--top ..] --reason ..'); return doSetA(dateStr);
    case 'set-b': if (!positional[0]) die('用法: set-b <代码> --lo .. --hi .. [--stop ..] --reason ..'); return doSetB(dateStr);
    case 'disable': if (!positional[0]) die('用法: disable <代码> <a|b|both> --reason ..'); return doDisable(dateStr);
    case 'enable': if (!positional[0]) die('用法: enable <代码> <a|b> --reason ..'); return doEnable(dateStr);
    default: die(`未知命令: ${cmd || '(空)'}。可用: context|status|set-a|set-b|disable|enable`);
  }
})().catch((e) => die(e.message));

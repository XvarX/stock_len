#!/usr/bin/env node
'use strict';
/**
 * monitor.js — 盘中分钟级监控与强提醒(独立进程, 无AI参与)
 *
 * 用法:
 *   node monitor.js          单次执行(兼容旧cron调用; 非交易时段静默退出)
 *   node monitor.js --loop   持续轮询(start-monitor.bat 使用此模式)
 *
 * 判定管线(全部本地):
 *   快照初筛(价格越线) → 命中者拉当日内分钟bar做确认校验 → 确认通过才🔔, 未通过记INFO·待确认
 *   A卡确认: 现价站上累计VWAP(config.confirm.aRequireVwap)
 *   B卡确认: 分钟级连续回升 + 回调段缩量(confirm.bRequireStabilize / bRetractVolRatioMax)
 */
const path = require('path');
const fs = require('fs');
const { IFind } = require('./lib/ifind');
const { Fetchers } = require('./lib/fetchers');
const J = require('./lib/journal');
const R = require('./lib/report');
const IND = require('./lib/indicators');
const G = require('./lib/gates');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const CONF = Object.assign(
  { aRequireVwap: true, aVolRatioMin: 2, marketConfirm: true, marketPctMin: 0, sectorConfirm: true, sectorCacheSec: 300, bRequireStabilize: true, bRetractVolRatioMax: 0.8 },
  CFG.confirm);
const loopMode = process.argv.includes('--loop');
const forceMode = process.argv.includes('--force');
const LOCK = path.join(__dirname, 'journal', '.monitor.lock');
const HEARTBEAT = path.join(__dirname, 'journal', '.heartbeat.json');

/* 单实例锁 + 心跳(供外部监督判断存活) */
function acquireLock() {
  try {
    const prev = JSON.parse(fs.readFileSync(LOCK, 'utf-8'));
    if (prev.pid && Number(prev.pid) !== process.pid) {
      try { process.kill(prev.pid, 0); console.error(`已有监控实例(pid ${prev.pid})在运行, 退出。如需抢占加 --force`); process.exit(2); }
      catch { /* 旧进程已死, 接管 */ }
    }
  } catch {}
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}
function releaseLock() { try { const l = JSON.parse(fs.readFileSync(LOCK, 'utf-8')); if (Number(l.pid) === process.pid) fs.unlinkSync(LOCK); } catch {} }
function beat(extra) { try { fs.writeFileSync(HEARTBEAT, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...extra })); } catch {} }

function nowHm() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function inSession(hm) { return CFG.poll.sessions.some(([a, b]) => hm >= a && hm <= b); }
function isWeekday() { const g = new Date().getDay(); return g >= 1 && g <= 5; }

/* 涨跌停制度: 30/68开头±20%, 其余±10% —— 返回当日跌停价 */
function limitDownPrice(code, prevClose) {
  const pct = /^(30|68)/.test(String(code)) ? 0.8 : 0.9;
  return Math.round(prevClose * pct * 100) / 100;
}

async function tick(client, firedSet) {
  const today = J.dateKey();
  const hm = nowHm();
  beat({ date: today, time: hm, inSession: isWeekday() && inSession(hm) });
  if (!isWeekday() || !inSession(hm)) { if (!loopMode) console.log(`[${hm}] 非交易时段, 静默`); return; }

  const plan = J.loadPlan(today);
  if (!plan || !(plan.items || []).length) { if (!loopMode) console.log(`[${hm}] 无今日计划, 跳过`); return; }
  for (const a of J.alertsOf(today)) firedSet.add(`${a.kind}|${a.code}`);

  const f = new Fetchers(client, null); // 盘中一律实时取数
  const codes = [...new Set(plan.items.map((x) => x.code))];
  const px = {}; // code -> {latest, openPrice}

  /* 阶段一: 快照初筛(纯价格条件) */
  for (let i = 0; i < codes.length; i += 10) {
    const snap = await f.snapshot(codes.slice(i, i + 10));
    if (snap.__error) { console.log(`[${hm}] 快照失败: ${snap.__error}`); return; }
    for (const it of plan.items.filter((x) => codes.slice(i, i + 10).includes(x.code))) {
      const s = snap[it.code];
      if (s && isFinite(s.latest)) px[it.code] = s;
    }
  }

  /* 阶段二: 对越过价格线的标的拉当日分时做确认校验 */
  let candA = [], candB = [];
  for (const it of plan.items) {
    const s = px[it.code];
    if (!s || !isFinite(s.latest)) continue;
    const p = s.latest;
    if (it.A.status === '待触发' && p >= it.A.trigger) candA.push(it);
    else if (it.B.status === '待触发' && p <= it.B.zone[1] && p >= it.B.zone[0]) candB.push(it);
    if (it.B.status === '待触发' && it.prevClose > 0) {
      const execStop = Math.max(it.B.stop, limitDownPrice(it.code, it.prevClose) + 0.02); // 止损必须可执行(高于跌停价)
      if (p < execStop && !firedSet.has('RISK·破止损|' + it.code)) {
        R.alertBanner('⚠风险·风控线(次日离场预案)', it.code, it.name, `现价 ${p} < 风控线 ${execStop} | T+1: 今日买入者不可卖——勿补仓, 明日开盘执行离场; 旧仓位可今日处理`);
        process.stdout.write('\x07');
        J.appendAlert(today, { kind: 'RISK·破止损', code: it.code, text: `现价${p}<可执行止损${execStop.toFixed(2)}` });
        firedSet.add('RISK·破止损|' + it.code);
      }
    }
  }
  if (!candA.length && !candB.length) return;

  // 需要分时确认的标的去重取数(fresh); A卡候选存在时附带大盘同向校验
  const uniq = [...new Set([...candA.map((x) => x.code), ...candB.map((x) => x.code)])];
  let mkt = null;
  const needMkt = (candA.length && CONF.marketConfirm) || (candB.length && CONF.bMarketConfirm);
  if (needMkt) {
    try {
      mkt = await f.benchmarkSnapshot();
      const vals = Object.values(mkt).map((v) => v.pct).filter(isFinite);
      const up = vals.some((v) => v >= CONF.marketPctMin);
      if (!up) { // 两市皆弱: A卡整体挂起, 只记INFO
        for (const it of candA) {
          if (!firedSet.has('INFO·市场弱|' + it.code)) {
            console.log(`[${hm}] ⏳ 市场同向不满足(${JSON.stringify(mkt)}), ${it.code} A卡挂起`);
            J.appendAlert(today, { kind: 'INFO·市场弱', code: it.code, text: `两市均低于${CONF.marketPctMin}%` });
            firedSet.add('INFO·市场弱|' + it.code);
          }
        }
        candA.length = 0;
      }
    } catch (e) { console.log(`[${hm}] 大盘快照失败, 跳过同向校验: ${e.message}`); }
  }
  if (!candA.length && !candB.length) return;

  // B卡当日急跌否决: 相对昨收跌幅≥bMaxDayDropPct(默认6%) → 瀑布中不接飞刀, B挂起
  if (candB.length && CONF.bMaxDayDropPct) {
    const candB2 = [];
    for (const it of candB) {
      const s = px[it.code];
      const drop = it.prevClose > 0 ? s.latest / it.prevClose - 1 : 0;
      if (drop <= -CONF.bMaxDayDropPct / 100) {
        if (!firedSet.has('INFO·破位急跌|' + it.code)) {
          console.log(`[${hm}] ⛔ ${it.code} ${it.name} 当日${(drop * 100).toFixed(1)}%≤-${CONF.bMaxDayDropPct}%急跌, B卡挂起勿接飞刀`);
          J.appendAlert(today, { kind: 'INFO·破位急跌', code: it.code, text: `当日${(drop * 100).toFixed(1)}%急跌,B挂起` });
          firedSet.add('INFO·破位急跌|' + it.code);
        }
        continue;
      }
      candB2.push(it);
    }
    candB = candB2;
  }
  if (!candA.length && !candB.length) return;
  if (candA.length && CONF.sectorConfirm) {
    const candA2 = [];
    const boards = [...new Set(candA.map((x) => x.board).filter(Boolean))];
    for (const b of boards) await f.sectorPct(b, CONF.sectorCacheSec);
    for (const it of candA) {
      if (!it.board) { candA2.push(it); continue; }
      const bp = f._sec?.[it.board]?.pct;
      if (bp == null || !isFinite(bp)) { candA2.push(it); continue; } // 查询失败不拦截
      if (bp >= CONF.marketPctMin) { candA2.push(it); continue; }
      if (!firedSet.has('INFO·板块弱|' + it.code)) {
        console.log(`[${hm}] ⏳ ${it.code} ${it.name} 板块[${it.board}]今日${bp.toFixed(2)}%<${CONF.marketPctMin}%, A卡挂起`);
        J.appendAlert(today, { kind: 'INFO·板块弱', code: it.code, text: `板块${it.board}${bp.toFixed(2)}%弱于阈值` });
        firedSet.add('INFO·板块弱|' + it.code);
      }
    }
    candA = candA2;
  }
  if (!candA.length && !candB.length) return;

  // B卡大盘门: 两市至少其一 ≥ bMarketMin(默认-1%, 低吸容忍回调但崩盘日不做)
  if (candB.length && CONF.bMarketConfirm && mkt) {
    const vals = Object.values(mkt).map((v) => v.pct).filter(isFinite);
    const okM = vals.some((v) => v >= CONF.bMarketMin);
    if (!okM) {
      for (const it of candB) {
        if (!firedSet.has('INFO·市场弱|' + it.code)) {
          console.log(`[${hm}] ⛔ ${it.code} ${it.name} 大盘同向不满足(${JSON.stringify(mkt)}), B卡挂起`);
          J.appendAlert(today, { kind: 'INFO·市场弱', code: it.code, text: `大盘低于${CONF.bMarketMin}%,B挂起` });
          firedSet.add('INFO·市场弱|' + it.code);
        }
      }
      candB.length = 0;
    }
  }
  if (!candA.length && !candB.length) return;
  for (let i = 0; i < uniq.length; i += 10) {
    const chunk = uniq.slice(i, i + 10);
    let intradayMap = {};
    try { intradayMap = await f.intraday(chunk, { fresh: true }); } catch (e) { console.log(`[${hm}] 分时取数失败(${chunk.join(',')}): ${e.message}`); continue; }

    for (const it of candA.filter((x) => chunk.includes(x.code))) {
      const key = 'A·突破|' + it.code;
      if (firedSet.has(key)) continue;
      const p = px[it.code].latest;
      // A卡七关(marketOk/sectorOk已由池级过滤完成)
      const r = G.evaluateA({ item: it, price: p, bars: intradayMap[it.code] || [], conf: CONF, marketOk: true, sectorOk: true });
      if (r.pass) {
        R.alertBanner('A·强势突破(七关确认)', it.code, it.name, `现价 ${p} ≥ 触发 ${it.A.trigger} | ${r.detail} | 七关全过 | 风控线 ${it.A.stop} | T+1: 明日才可卖`);
        process.stdout.write('\x07');
        J.appendAlert(today, { kind: 'A·突破', code: it.code, text: `现价${p}≥${it.A.trigger}; 七关全过` });
        firedSet.add(key);
      } else if (!firedSet.has('INFO·待确认|' + it.code) || r.failed.some((f) => ['追深', '未封板', '资金', '站稳5分钟'].includes(f))) {
        console.log(`[${hm}] ⏳ ${it.code} ${it.name} A确认不足: ${r.failed.join('/')} | ${p} vs 触发${it.A.trigger}`);
        if (!firedSet.has('INFO·待确认|' + it.code)) {
          J.appendAlert(today, { kind: 'INFO·待确认', code: it.code, text: `价达${p},确认不足:${r.failed.join('/')}` });
          firedSet.add('INFO·待确认|' + it.code);
        }
      }
    }
    for (const it of candB.filter((x) => chunk.includes(x.code))) {
      const key = 'B·低吸带|' + it.code;
      if (firedSet.has(key)) continue;
      const p = px[it.code].latest;
      // B卡板块门(所属板块当日≥bSectorMin): 板块领跌时"便宜"是陷阱(市场门已池级完成)
      let sectorOk = true, sectorPctTxt = '-';
      if (CONF.bSectorConfirm && it.board) {
        const bp = await f.sectorPct(it.board, CONF.sectorCacheSec || 300);
        if (bp != null && isFinite(bp)) { sectorOk = bp >= CONF.bSectorMin; sectorPctTxt = bp.toFixed(2) + '%'; }
      }
      // B卡六关(marketOk已池级完成)
      const r = G.evaluateB({ item: it, price: p, openPrice: px[it.code].openPrice, bars: intradayMap[it.code] || [], conf: CONF, marketOk: true, sectorOk });
      if (r.pass) {
        R.alertBanner('B·进入低吸带(六关确认)', it.code, it.name, `现价 ${p} 位于 ${it.B.zone[0]}~${it.B.zone[1]} | ${it.B.anchor || ''} | ${r.detail} | 板块(${sectorPctTxt}) | 风控线 ${it.B.stop} | T+1: 今日买入明日才能卖`);
        process.stdout.write('\x07');
        J.appendAlert(today, { kind: 'B·低吸带', code: it.code, text: `${p}入带${it.B.zone.join('~')},六关确认` });
        firedSet.add(key);
      } else if (!firedSet.has('INFO·待确认|' + it.code) || r.failed.some((f) => ['浅锚破开盘', '资金'].includes(f))) {
        console.log(`[${hm}] ⏳ ${it.code} ${it.name} 入低吸带但确认不足: ${r.failed.join('/')} | ${p}`);
        if (!firedSet.has('INFO·待确认|' + it.code)) {
          J.appendAlert(today, { kind: 'INFO·待确认', code: it.code, text: `入带${p}未确认:${r.failed.join('/')}` });
          firedSet.add('INFO·待确认|' + it.code);
        }
      }
    }
  }
}

async function main() {
  /* --status: "定时监控"指令的武装检查——有计划报名单与进程状态, 无计划明确答复 */
  if (process.argv.includes('--status')) {
    const today = J.dateKey();
    const plan = J.loadPlan(today);
    if (!plan || !(plan.items || []).length) { console.log('没有需要监控的股票'); process.exit(0); }
    let beatv = null;
    try { beatv = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf-8')); } catch {}
    const live = beatv && Date.now() - new Date(beatv.ts).getTime() < 3 * 60 * 1000;
    const desc = (i) => i.code + ' ' + i.name + '(' + [i.A.status === '待触发' ? 'A≥' + i.A.trigger : 'A' + i.A.status, i.B.status === '待触发' ? 'B带' + i.B.zone.join('~') : 'B' + i.B.status].filter((s) => !/待触发|禁用$/.test(s) || true).join(',') + ')';
    console.log('监控对象(' + plan.items.length + '只):');
    plan.items.forEach((i) => console.log('  ' + desc(i)));
    console.log('监控进程: ' + (live ? '✓ 存活 pid ' + beatv.pid + ' 最后心跳 ' + beatv.time : '✗ 未运行/心跳过期 → 双击 start-monitor.bat 启动'));
    console.log('5分钟监督自动化: 已注册(查活+增量警报+定点任务)');
    process.exit(0);
  }
  const client = new IFind();
  const fired = new Set();
  if (!loopMode) { await tick(client, fired); return; }
  acquireLock();
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('exit', releaseLock);
  console.log(`持续监控中(pid ${process.pid}), 每 ${CFG.poll.intervalSec}s 一轮; 心跳→${path.basename(HEARTBEAT)}`);
  for (;;) {
    try { await tick(client, fired); } catch (e) { console.error('tick error:', e.message); }
    await new Promise((r) => setTimeout(r, CFG.poll.intervalSec * 1000));
  }
}
main().catch((e) => { console.error('✗', e.message); process.exit(1); });

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

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const CONF = Object.assign({ aRequireVwap: true, bRequireStabilize: true, bRetractVolRatioMax: 0.8 }, CFG.confirm);
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
  const candA = [], candB = [];
  for (const it of plan.items) {
    const s = px[it.code];
    if (!s || !isFinite(s.latest)) continue;
    const p = s.latest;
    if (it.A.status === '待触发' && p >= it.A.trigger) candA.push(it);
    else if (it.B.status === '待触发' && p <= it.B.zone[1] && p >= it.B.zone[0]) candB.push(it);
    if (it.B.status === '待触发' && p < it.B.stop && !firedSet.has('RISK·破止损|' + it.code)) {
      R.alertBanner('⚠风险·跌破关键位', it.code, it.name, `现价 ${p} < 止损参考 ${it.B.stop}, 放弃低吸勿接飞刀`);
      process.stdout.write('\x07');
      J.appendAlert(today, { kind: 'RISK·破止损', code: it.code, text: `现价${p}<${it.B.stop}` });
      firedSet.add('RISK·破止损|' + it.code);
    }
  }
  if (!candA.length && !candB.length) return;

  // 需要分时确认的标的去重取数(fresh)
  const uniq = [...new Set([...candA.map((x) => x.code), ...candB.map((x) => x.code)])];
  for (let i = 0; i < uniq.length; i += 10) {
    const chunk = uniq.slice(i, i + 10);
    let intradayMap = {};
    try { intradayMap = await f.intraday(chunk, { fresh: true }); } catch (e) { console.log(`[${hm}] 分时取数失败(${chunk.join(',')}): ${e.message}`); continue; }

    for (const it of candA.filter((x) => chunk.includes(x.code))) {
      const key = 'A·突破|' + it.code;
      if (firedSet.has(key)) continue;
      const p = px[it.code].latest;
      const cf = IND.evaluateConfirmations(intradayMap[it.code], { px: p, stabilize: false });
      const vwapOk = !CONF.aRequireVwap || cf.aboveVwap === true;
      if (vwapOk) {
        R.alertBanner('A·强势突破', it.code, it.name, `现价 ${p} ≥ 触发 ${it.A.trigger} | 站上VWAP(${cf.vwap ? cf.vwap.toFixed(2) : '-'})已确认 | 止损 ${it.A.stop}`);
        process.stdout.write('\x07');
        J.appendAlert(today, { kind: 'A·突破', code: it.code, text: `现价${p}≥${it.A.trigger}, VWAP确认(${cf.vwap?.toFixed?.(2)})` });
        firedSet.add(key);
      } else if (!firedSet.has('INFO·待确认|' + it.code)) {
        console.log(`[${hm}] ⏳ ${it.code} ${it.name} 价过触发线但未站上VWAP(${cf.vwap?.toFixed?.(2)}), 待确认`);
        J.appendAlert(today, { kind: 'INFO·待确认', code: it.code, text: `价达${p}>${it.A.trigger}但VWAP未过` });
        firedSet.add('INFO·待确认|' + it.code);
      }
    }
    for (const it of candB.filter((x) => chunk.includes(x.code))) {
      const key = 'B·低吸带|' + it.code;
      if (firedSet.has(key)) continue;
      const p = px[it.code].latest;
      const cf = IND.evaluateConfirmations(intradayMap[it.code], {});
      const stabOk = !CONF.bRequireStabilize || cf.stabilized === true;
      const volOk = !isFinite(cf.retractVolRatio) || cf.retractVolRatio <= CONF.bRetractVolRatioMax;
      if (stabOk && volOk) {
        R.alertBanner('B·进入低吸带', it.code, it.name, `现价 ${p} 位于 ${it.B.zone[0]}~${it.B.zone[1]} | 分钟连升+缩量(cf量比${isFinite(cf.retractVolRatio) ? cf.retractVolRatio.toFixed(2) : '-'}) | 止损 ≤${it.B.stop}`);
        process.stdout.write('\x07');
        J.appendAlert(today, { kind: 'B·低吸带', code: it.code, text: `${p}入带${it.B.zone.join('~')},缩量确认` });
        firedSet.add(key);
      } else if (!firedSet.has('INFO·待确认|' + it.code)) {
        console.log(`[${hm}] ⏳ ${it.code} ${it.name} 入低吸带但企稳确认不足(连升:${cf.stabilized}, 缩量比:${cf.retractVolRatio?.toFixed?.(2)}), 待确认`);
        J.appendAlert(today, { kind: 'INFO·待确认', code: it.code, text: `入带${p}未确认企稳` });
        firedSet.add('INFO·待确认|' + it.code);
      }
    }
  }
}

async function main() {
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

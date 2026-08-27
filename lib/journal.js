'use strict';
/**
 * journal.js — 分析结果持久化: 作战计划(plans) / 盘中预警(alerts) / 收盘复盘(reviews)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'journal');

function dateKey(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function isWeekend(d) { const g = d.getDay(); return g === 0 || g === 6; }
function nextTradingDay(dstr) {
  const norm = String(dstr).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'); // 兼容YYYYMMDD
  const d = new Date(norm + 'T12:00:00');
  if (isNaN(d.getTime())) return String(dstr);
  do { d.setDate(d.getDate() + 1); } while (isWeekend(d)); // 法定假日不建模, 报告中提示
  return dateKey(d);
}

function ensure(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }

/** 夜间计划落盘: 人类可读 markdown + 内嵌机器JSON(monitor/auction 解析用) */
function savePlan(targetDate, payload) {
  const p = path.join(ROOT, 'plans', `${targetDate}.md`);
  const rows = payload.items.map((it) =>
    `| ${it.code} | ${it.name} | ${it.prevClose} | ${it.A.status === '待触发' ? `≥${it.A.trigger}` : it.A.status} | ${it.A.status === '待触发' ? `≤${it.A.stop}` : '-'} | ${it.B.status === '待触发' ? `${it.B.zone[0]}~${it.B.zone[1]}` : it.B.status} | ${it.B.status === '待触发' ? `≤${it.B.stop}` : '-'} | ${(it.notes || []).join(';') || '-'} |`).join('\n');
  const md = `# 作战计划 · ${targetDate}
> 生成于 ${payload.generatedAt} | 市场温度计: **${payload.temperature.label}** ${payload.scanSource ? `(来源: 自动扫描)` : ''}

| 代码 | 名称 | 昨收 | A卡触发 | A卡止损 | B卡低吸带 | B卡止损 | 备注 |
|---|---|---|---|---|---|---|---|
${rows}

${payload.guardLines?.length ? `## 全局纪律\n${payload.guardLines.map((g) => `- ${g}`).join('\n')}\n` : ''}
## 机器可读区
\`\`\`json
${JSON.stringify(payload)}
\`\`\`
`;
  ensure(p); fs.writeFileSync(p, md, 'utf-8');
  return p;
}

function loadPlan(targetDate) {
  const p = path.join(ROOT, 'plans', `${targetDate}.md`);
  try {
    const md = fs.readFileSync(p, 'utf-8');
    const m = md.match(/```json\n([\s\S]*?)\n```/);
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; }
}

function appendAlert(dateStr, obj) {
  const p = path.join(ROOT, 'alerts', `${dateStr}.jsonl`);
  ensure(p);
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n', 'utf-8');
}

function alertsOf(dateStr) {
  try {
    return fs.readFileSync(path.join(ROOT, 'alerts', `${dateStr}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function saveReview(dateStr, mdText) {
  const p = path.join(ROOT, 'reviews', `${dateStr}.md`);
  ensure(p); fs.writeFileSync(p, mdText, 'utf-8');
  return p;
}

module.exports = { savePlan, loadPlan, appendAlert, alertsOf, saveReview, dateKey, nextTradingDay };

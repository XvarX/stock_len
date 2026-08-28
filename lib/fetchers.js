'use strict';
/**
 * fetchers.js — 取数模块(带当日缓存)
 * 统一输出归一化结构: 日线bars升序 / 分时bars / 快照 / 板块 / 身份
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { colKey } = require('./ifind');

function num(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : NaN;
}

class Fetchers {
  constructor(client, cacheDir) {
    this.c = client;
    this.cacheDir = cacheDir; // cache/YYYY-MM-DD，可为null禁用缓存
  }
  _cached(key, fn) {
    if (!this.cacheDir) return fn();
    const file = path.join(this.cacheDir, crypto.createHash('sha1').update(key).digest('hex').slice(0, 24) + '.json');
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Promise.resolve(cached.ok === false ? fn() : cached); // 失败结果不缓存, 直接重试
    } catch {
      return fn().then((v) => { try { fs.mkdirSync(this.cacheDir, { recursive: true }); if (!v || v.ok === false) return v; fs.writeFileSync(file, JSON.stringify(v)); } catch {} return v; });
    }
  }
  async _tableOf(serverType, toolName, params, cacheKeyExtra = '') {
    return this._cached(`${serverType}|${toolName}|${JSON.stringify(params)}|${cacheKeyExtra}`, async () => {
      const r = await this.c.biz(serverType, toolName, params);
      if (!r.ok || !r.inner) return { ok: false, error: r.errorText };
      if (r.inner.tables && r.inner.tables.length > 1) {
        const head = r.inner.tables[0].map(colKey);
        return { ok: true, rows: r.inner.tables.slice(1).map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']))) };
      }
      // markdown answer 型
      const md = r.inner.answer ? String(r.inner.answer) : null;
      if (!md) return { ok: false, error: 'no answer', meta: r.inner };
      const { parseMarkdownTable } = require('./ifind');
      return { ok: true, truncated: /截断|以下为部分数据/.test(md), answerMd: md, rows: parseMarkdownTable(md) };
    });
  }

  /** 个股身份: 简称+申万行业+概念板块 */
  async identity(code) {
    const base = this._tableOf('stock', 'get_stock_info', { query: `${code}的证券简称、所属申万行业` });
    const concepts = this._tableOf('stock', 'get_stock_info', { query: `${code}所属的全部概念板块` });
    const [b, c] = await Promise.all([base, concepts]);
    let name = '', sw = '';
    for (const r of b.rows || []) {
      if (!name && r.name) name = r.name;
      const swKey = Object.keys(r).find((k) => k.includes('行业') && k !== 'swIndustry');
      if (swKey) sw = r[swKey];
    }
    let conceptList = [];
    for (const r of c.rows || []) for (const [k, v] of Object.entries(r)) if (/概念/.test(k)) conceptList = String(v).split(/[,，]/).map(x=>x.trim()).filter(Boolean);
    return { code, name, swIndustry: sw, concepts: conceptList, ok: !!name };
  }

  /** 个股日线(按日历区间取, 升序)。注意: 服务端对"最近N个交易日"长窗口解析异常, 必须用显式日期范围 */
  async dailyStock(code, calDays) {
    const p = (x) => String(x).padStart(2, '0');
    const end = new Date();
    const start = new Date(Date.now() - calDays * 86400000);
    const fmtCn = (d) => `${d.getFullYear()}年${p(d.getMonth() + 1)}月${p(d.getDate())}日`;
    const q = `${code}从${fmtCn(start)}到${fmtCn(end)}的每日开盘价、最高价、最低价、收盘价、涨跌幅、成交量`;
    const r = await this._tableOf('stock', 'get_stock_performance', { query: q });
    if (!r.ok) return { ok: false, error: r.error };
    const bars = r.rows
      .filter((x) => String(x.pct ?? '').trim() !== '' && isFinite(num(x.pct))) // 剔除非交易日空值行
      .map((x) => ({ date: x.date, open: num(x.open), high: num(x.high), low: num(x.low), close: num(x.close), pct: num(x.pct), volume: num(x.volume), amount: num(x.amount) }))
      .filter((b) => isFinite(b.close))
      .sort((a, b2) => String(a.date).localeCompare(String(b2.date)));
    return { ok: bars.length > 0, truncated: !!r.truncated, bars, note: bars.length && r.rows.length > bars.length ? `已剔除${r.rows.length - bars.length}个空值行` : null };
  }

  /** 指数日线(N日, 升序) */
  async dailyIndex(name, days) {
    const q = `${name}最近${days}个交易日的每日收盘点数和每日涨跌幅`;
    const r = await this._tableOf('index', 'index_data', { query: q });
    if (!r.ok) return { ok: false, error: r.error };
    const bars = r.rows
      .filter((x) => String(x.pct).trim() !== '' && isFinite(num(x.pct)))
      .map((x) => ({ date: x.date, close: num(x.close), pct: num(x.pct) }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return { ok: bars.length > 0, bars };
  }

  /** 板块当日 + 尽力取序列 */
  async board(name) {
    const today = await this._tableOf('index', 'sector_data', { query: `${name}单个交易日的板块涨跌幅`, }, 'T');
    let pctToday = NaN, extra = null;
    for (const r of today.rows || []) for (const [k, v] of Object.entries(r)) if (k === 'pct' || k.includes('涨跌幅')) pctToday = num(v);
    const params = today.meta?.indicator_params || {};
    extra = JSON.stringify(params);
    // 序列尝试: 服务端可能仅给区间聚合值
    const ser = await this._tableOf('index', 'sector_data', { query: `${name}最近20个交易日每个交易日的板块涨跌幅序列` });
    let series = [];
    if (ser.rows && ser.rows.some((x) => Object.values(x).some((v) => /^\d{8}$/.test(String(v))))) {
      for (const x of ser.rows) {
        const dk = Object.keys(x).find((k) => k === 'date');
        const pk = Object.keys(x).find((k) => k === 'pct' || k.includes('涨跌幅'));
        if (dk && pk && isFinite(num(x[pk]))) series.push({ date: x[dk], pct: num(x[pk]) });
      }
      series.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }
    return { name, pctToday: isFinite(pctToday) ? pctToday : null, rawMeta: extra, series: series.length >= 5 ? series : null };
  }

  /** 当日1分钟分时(多标的单调用, ≤10只)。fresh=true 跳过缓存(盘中实时判定必须实时取) */
  async intraday(codes, opts = {}) {
    const out = {};
    const grab = (chunk) => opts.fresh
      ? this.c.biz('stock', 'stock_highfreq_quotes', {
          symbols: chunk.join(','), indicators: '开盘价,最高价,最低价,收盘价,成交量,成交额',
          data_mode: 'highfreq', interval: 1 })
      : this._cached(`stock|stock_highfreq_quotes|HF|${chunk.join(',')}`, () =>
          this.c.biz('stock', 'stock_highfreq_quotes', {
            symbols: chunk.join(','), indicators: '开盘价,最高价,最低价,收盘价,成交量,成交额',
            data_mode: 'highfreq', interval: 1 }));
    for (let i = 0; i < codes.length; i += 10) {
      const r = await grab(codes.slice(i, i + 10));
      if (!r.ok || !r.inner?.tables) continue;
      const head = r.inner.tables[0].map(colKey);
      const symMap = r.inner.sympolMap || {};
      for (const cells of r.inner.tables.slice(1)) {
        const o = Object.fromEntries(head.map((h, j) => [h, cells[j] ?? '']));
        const key = (o.code || '').split('.')[0];
        (out[key] = out[key] || []).push({ time: o.time, open: num(o.open), high: num(o.high), low: num(o.low), close: num(o.close), volume: num(o.volume), amount: num(o.amount) });
      }
    }
    for (const k of Object.keys(out)) out[k].sort((a, b) => String(a.time).localeCompare(String(b.time)));
    return out;
  }

  /** 大盘基准实时(上证+创业板指涨跌幅), 供A卡市场同向确认 */
  async benchmarkSnapshot() {
    const r = await this.c.biz('index', 'index_highfreq_quotes', {
      symbols: '上证指数,创业板指', indicators: '最新价,涨跌幅', data_mode: 'real_time' });
    const res = {};
    if (r.ok && r.inner?.tables) {
      const head = r.inner.tables[0].map(colKey);
      for (const cells of r.inner.tables.slice(1)) {
        const o = Object.fromEntries(head.map((h, j) => [h, cells[j] ?? '']));
        res[o.name || o.code] = { pct: num(o.pct) };
      }
    }
    return res;
  }

  /** 板块当日涨跌幅(sector_data慢接口): 同名TTL缓存, 监控轮询按板块去重后调用 */
  async sectorPct(name, ttlSec = 300) {
    if (!name) return null;
    this._sec = this._sec || {};
    const hit = this._sec[name];
    if (hit && Date.now() - hit.ts < ttlSec * 1000) return hit.pct;
    try {
      const r = await this._tableOf('index', 'sector_data', { query: `${name}板块今日的板块涨跌幅` }, `S${Math.floor(Date.now() / (ttlSec * 1000))}`);
      let pct = NaN;
      for (const row of r.rows || []) for (const [k, v] of Object.entries(row)) if (k === 'pct' || k.includes('涨跌幅')) pct = num(v);
      if (!isFinite(pct)) return null;
      this._sec[name] = { pct, ts: Date.now() };
      return pct;
    } catch { return null; }
  }

  /** 实时快照(≤10只): 盘中监控与竞价校准用 */
  async snapshot(codes) {
    const r = await this.c.biz('stock', 'stock_highfreq_quotes', {
      symbols: codes.join(','), indicators: '最新价,涨跌幅,开盘价',
      data_mode: 'real_time' });
    const res = {};
    if (r.ok && r.inner?.tables) {
      const head = r.inner.tables[0].map(colKey);
      for (const cells of r.inner.tables.slice(1)) {
        const o = Object.fromEntries(head.map((h, j) => [h, cells[j] ?? '']));
        res[(o.code || '').split('.')[0]] = { time: o.time, latest: num(o.latest), pct: num(o.pct), openPrice: num(o.open) };
      }
    } else {
      res.__error = r.errorText || 'snapshot failed';
    }
    return res;
  }

  /** 概念宽度: 成分股个数(数字货币~百级 vs 数字经济~千级)——宽概念降权用 */
  async sectorBreadth(name) {
    if (!name) return null;
    try {
      const r = await this._tableOf('index', 'sector_data', { query: `${name}板块的成分股个数` }, `B${Math.floor(Date.now() / 86400000)}`);
      let n = NaN;
      for (const row of r.rows || []) for (const [k, v] of Object.entries(row)) if (k.includes('个数') || k.includes('数量')) n = parseInt(String(v).replace(/[^0-9]/g, ''));
      return isFinite(n) ? n : null;
    } catch { return null; }
  }

  /** 催化确认: 题材近N日新闻共振(search_news) */
  async newsCatalyst(boardName, days = 3) {
    if (!boardName) return null;
    try {
      const end = new Date(), start = new Date(Date.now() - days * 86400000);
      const p = (x) => String(x).padStart(2, '0');
      const d = (dt) => `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
      const r = await this.c.biz('news', 'search_news', {
        query: `${boardName} 涨停 催化`, time_start: d(start), time_end: d(end), size: 5 });
      if (!r.ok || !r.inner) return null;
      let items = [];
      try { items = JSON.parse(r.inner.data || r.inner.answer || '[]'); } catch { return { count: 0, items: [] }; }
      if (!Array.isArray(items)) items = [];
      return { count: items.length, headline: items[0] ? (items[0]['资讯标题'] || items[0].title || '') : '' };
    } catch { return null; }
  }

  /** 主力资金流(近5日, ≤5只/次): [{code,name}] -> { code: {today, cum5, lastDate, series} } 单位元 */
  async flowSeries(pairs) {
    const out = {};
    for (let i = 0; i < pairs.length; i += 5) {
      const chunk = pairs.slice(i, i + 5);
      const r = await this._tableOf('stock', 'get_stock_performance',
        { query: `${chunk.map((p) => p.name).join('、')}近5日主力净流入额` }, 'FLOW5');
      if (!r.ok) continue;
      for (const row of r.rows || []) {
        const code = String(row.code || '').split('.')[0];
        if (!/^\d{6}$/.test(code)) continue;
        const v = parseFlowVal(row.flow);
        if (v === null) continue;
        (out[code] = out[code] || { series: [] }).series.push({ date: String(row.date || ''), val: v });
      }
    }
    for (const code of Object.keys(out)) {
      const s = out[code].series.sort((a, b) => (a.date < b.date ? 1 : -1));
      out[code].lastDate = s[0] ? s[0].date : null;
      out[code].today = s[0] ? s[0].val : NaN;
      out[code].cum5 = s.slice(0, 5).reduce((acc, x) => acc + x.val, 0);
    }
    return out;
  }
}

/** 资金额解析: "5.1256亿"→5.1256e8, "-64223093.8"→原值, 空/\\t/占位→null */
function parseFlowVal(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '\\t' || s === '-' || s === '--') return null;
  if (/亿$/.test(s)) { const n = parseFloat(s); return isFinite(n) ? n * 1e8 : null; }
  if (/万$/.test(s)) { const n = parseFloat(s); return isFinite(n) ? n * 1e4 : null; }
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

module.exports = { Fetchers, num, parseFlowVal };

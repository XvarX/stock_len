'use strict';
/**
 * ifind.js — iFind MCP 接口层
 * 职责: 限速(免费版2req/s) / 并发控制 / 逐调用计时 / 失败重试 / 业务层统一解析
 * 会话: 自实现HTTP客户端 + 磁盘持久化Mcp-Session-Id(跨进程复用, 失效自动重建), 避免会话风暴
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
}
const CFG = loadConfig();
// 密钥解析链: 环境变量 IFIND_MCP_KEY → 项目根 ifind_key.json → 已安装iFind技能的mcp_config.json
function resolveAuth() {
  if (process.env.IFIND_MCP_KEY) return process.env.IFIND_MCP_KEY;
  const local = path.join(__dirname, '..', 'ifind_key.json');
  try { return JSON.parse(fs.readFileSync(local, 'utf-8')).auth_token; } catch {}
  try {
    const cfgPath = path.join(path.dirname(CFG.ifindSkillPath), 'mcp_config.json');
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).auth_token;
  } catch {}
  throw new Error('未找到 iFinD 密钥: 设置环境变量 IFIND_MCP_KEY, 或在项目根创建 ifind_key.json {"auth_token":"..."} , 或安装 iFind 技能');
}
const META = { auth: resolveAuth(), servers: (() => {
  const BASE = 'https://api-mcp.51ifind.com:8643/ds-mcp-servers';
  return {
    stock: `${BASE}/hexin-ifind-ds-stock-mcp`, fund: `${BASE}/hexin-ifind-ds-fund-mcp`,
    edb: `${BASE}/hexin-ifind-ds-edb-mcp`, news: `${BASE}/hexin-ifind-ds-news-mcp`,
    bond: `${BASE}/hexin-ifind-ds-bond-mcp`, global_stock: `${BASE}/hexin-ifind-ds-global-stock-mcp`,
    index: `${BASE}/hexin-ifind-ds-index-mcp`,
  };
})() };
const SESSION_FILE = path.join(os.tmpdir(), `ifind_mcp_sessions_${(META.auth || '').slice(-12)}.json`);
let SESSIONS = {};
try { SESSIONS = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')); } catch {}
function saveSessions() { try { fs.writeFileSync(SESSION_FILE, JSON.stringify(SESSIONS)); } catch {} }

function post(urlStr, payload, sessionId, timeoutSec = 60) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': META.auth,
      'Content-Length': Buffer.byteLength(body),
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST', headers, timeout: timeoutSec * 1000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed = null;
        if (data.trim()) { try { parsed = JSON.parse(data); } catch { parsed = data; } }
        resolve({ status: res.statusCode, headers: res.headers, data: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout ${timeoutSec}s`)); });
    req.write(body); req.end();
  });
}

/** 确保某服务的MCP会话可用(磁盘复用; 初始化后必发initialized通知) */
async function ensureSession(serverType) {
  const hit = SESSIONS[serverType];
  if (hit && Date.now() - hit.ts < 8 * 3600 * 1000) return hit.id;
  delete SESSIONS[serverType];
  const init = await post(META.servers[serverType], {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stock-lens', version: '1.0' } },
  }, null, 30);
  if (init.status >= 400) throw new Error(`initialize HTTP ${init.status}`);
  const sid = init.headers['mcp-session-id'];
  if (!sid) throw new Error('initialize 成功但未返回 Mcp-Session-Id');
  SESSIONS[serverType] = { id: sid, ts: Date.now() };
  saveSessions();
  await post(META.servers[serverType], { jsonrpc: '2.0', method: 'notifications/initialized' }, sid, 10).catch(() => {});
  return sid;
}

/** MCP tools/call 原始调用(会话失效自动重建重试一次) */
async function rawCall(serverType, toolName, params) {
  const doCall = async (sid) => post(META.servers[serverType], {
    jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6),
    method: 'tools/call', params: { name: toolName, arguments: params },
  }, sid, 90);
  let sid = await ensureSession(serverType);
  let r = await doCall(sid);
  const dead = r.status === 400 || r.status === 404 || r.status === 410 ||
    (r.data && r.data.error && /session/i.test(JSON.stringify(r.data.error)));
  if (dead) {
    delete SESSIONS[serverType]; saveSessions();
    sid = await ensureSession(serverType);
    r = await doCall(sid);
  }
  // 归一化为旧 call-node.js 的形状 {ok,status_code,data}
  const okShape = r.status < 400 && !(r.data && typeof r.data === 'object' && 'error' in r.data);
  return { ok: okShape, status_code: r.status, data: r.data, raw_error: (!okShape && r.data && r.data.error) ? r.data.error : null };
}

class Limiter {
  constructor(cfg) {
    this.maxConcurrent = cfg.maxConcurrent;
    this.minGapMs = cfg.minGapMs;
    this.active = 0;
    this.lastDispatch = 0;
    this.dispatchLog = []; // 最近1秒内的派发时刻
    this.queue = [];
  }
  async _slot() {
    for (;;) {
      const now = Date.now();
      this.dispatchLog = this.dispatchLog.filter((t) => now - t < 1000);
      if (this.active < this.maxConcurrent && this.dispatchLog.length < 2 && now - this.lastDispatch >= this.minGapMs) {
        this.active++;
        this.lastDispatch = now;
        this.dispatchLog.push(now);
        return;
      }
      const windowFull = this.dispatchLog.length >= 2;
      const wait1 = windowFull ? Math.max(0, 1000 - (now - this.dispatchLog[0])) : 0;
      const wait2 = Math.max(0, this.minGapMs - (now - this.lastDispatch));
      const wait3 = this.active >= this.maxConcurrent ? 120 : 0;
      await new Promise((r) => setTimeout(r, Math.max(wait1, wait2, wait3)));
    }
  }
  async run(fn) {
    await this._slot();
    try { return await fn(); } finally { this.active--; }
  }
}

class IFind {
  constructor(opts = {}) {
    this.limiter = new Limiter({ ...CFG.throttle, ...opts.throttle });
    this.log = [];
    this._rawCall = (serverType, toolName, params) => rawCall(serverType, toolName, params);
  }
  /** 单次底层调用: 限速+重试+计时, 返回 {ok,status,data} 原始结构 */
  async _request(serverType, toolName, params, retries = 1) {
    for (let attempt = 0; ; attempt++) {
      const r = await this.limiter.run(() => this._rawCall(serverType, toolName, params));
      const netFail = !r || (!r.ok && !(r.error && r.error.code === -32602));
      if (!netFail || attempt >= retries) return { r, attempt };
      await new Promise((res) => setTimeout(res, 800)); // 网络失败退避重试
    }
  }
  /**
   * 业务调用: 返回统一结构
   * { ok, httpStatus, ms, attempts, inner }  inner: 解析后的业务对象(markdown含answer / 表格含tables)
   */
  async biz(serverType, toolName, params) {
    const t0 = Date.now();
    let out;
    try {
      const { r, attempt } = await this._request(serverType, toolName, params);
      const ms = Date.now() - t0;
      const text = r?.data?.result?.content?.[0]?.text ?? null;
      let inner = null, ok = false;
      if (text) {
        try { const outer = JSON.parse(text); inner = typeof outer.data === 'string' ? JSON.parse(outer.data) : outer.data; ok = outer.code === 1; }
        catch { inner = text; }
      }
      out = { ok, httpStatus: r.status_code, ms, attempts: attempt + 1, toolName, serverType, inner, errorText: ok ? null : (r.error ? JSON.stringify(r.error) : text ? String(text).slice(0, 200) : 'no content') };
    } catch (e) {
      out = { ok: false, httpStatus: null, ms: Date.now() - t0, attempts: 1, toolName, serverType, inner: null, errorText: e.message };
    }
    this.log.push({ name: `${serverType}.${toolName}`, ok: out.ok, ms: out.ms });
    return out;
  }
  timingTable() {
    const total = this.log.reduce((s, x) => s + x.ms, 0);
    const fails = this.log.filter((x) => !x.ok).length;
    return `接口耗时合计 ${(total / 1000).toFixed(1)}s | ${this.log.length} 次调用 | 失败 ${fails} 次\n` +
      this.log.map((x) => `  ${x.ok ? '✓' : '✗'} ${x.name.padEnd(28)} ${x.ms}ms`).join('\n');
  }
}

/** 列名 → 标准字段(归一化所有表格分支的口径) */
function colKey(h) {
  const s = String(h);
  if (s === 'time') return 'time';
  if (s.includes('日期')) return 'date';
  if (s.includes('开盘')) return 'open';
  if (s.includes('最高')) return 'high';
  if (s.includes('最低')) return 'low';
  if (s.includes('收盘')) return 'close';
  if (s.includes('最新')) return 'latest';
  if (s.includes('涨跌幅') || s.includes('涨幅')) return 'pct';
  if (s.includes('成交量')) return 'volume';
  if (s.includes('成交额')) return 'amount';
  if (s.includes('时间')) return 'time';
  if (s.includes('证券代码') || s.endsWith('代码') || s === 'code') return 'code';
  if (s.includes('简称') || s.includes('名称')) return 'name';
  return h;
}

/** 解析 markdown 表格文本为对象数组(列名经colKey归一化; 空单元格保留以稳定列序) */
function parseMarkdownTable(md) {
  if (!md) return [];
  const lines = md.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const splitRow = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const head = splitRow(lines[0]).map(colKey);
  const body = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    body.push(Object.fromEntries(head.map((h, j) => [h, cells[j] ?? ''])));
  }
  return body;
}

module.exports = { IFind, parseMarkdownTable, colKey, CFG };

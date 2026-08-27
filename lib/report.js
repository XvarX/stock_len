'use strict';
/** report.js — 报告渲染与控制台强提醒 */

function fmt(x, d = 2) { return isFinite(x) ? Number(x).toFixed(d) : '-'; }

function stockBlock(st) {
  const L = [];
  L.push(`## ${st.code} ${st.name}`);
  if (st.error) { L.push(`> ⚠ ${st.error}`); return L.join('\n'); }
  L.push(`行业:${st.swIndustry || '-'} | 热点归属:${st.board || '-'}`);
  const ds = st.ds;
  L.push(`\n### 日线(${ds.date} 收盘)`);
  L.push(`- 收盘 ${fmt(ds.close)} (${ds.pctToday >= 0 ? '+' : ''}${fmt(ds.pctToday)}%)${ds.boardQ?.sealed ? ' **封板**' : ds.boardQ?.broken ? ' **炸板**' : ''} | 近${20}日累计 ${fmt(ds.cumWin)}% | 区间分位 ${fmt(ds.posPct, 0)}% | 结构: **${ds.posTag}**`);
  L.push(`- MA5/10/20/60 = ${fmt(ds.ma.ma5)} / ${fmt(ds.ma.ma10)} / ${fmt(ds.ma.ma20)} / ${fmt(ds.ma.ma60)}`);
  L.push(`- MACD DIF ${fmt(ds.macd.dif)} DEA ${fmt(ds.macd.dea)} (${ds.macd.crossUp ? '多头' : '空头'}) | KDJ ${fmt(ds.kdj.k)}/${fmt(ds.kdj.d)}/${fmt(ds.kdj.j)} | RSI14 ${fmt(ds.rsi14, 0)}`);
  L.push(`- 量能: 涨日量/跌日量 ${fmt(ds.vol.upDownRatio)} | 近5日均量/前15日均量 ${fmt(ds.vol.accel)}${ds.blowoff ? ` | ⚠ 天量长阴遗迹 ${ds.blowoff.date}` : ''}`);
  if (ds.flow && (isFinite(ds.flow.today) || isFinite(ds.flow.cum5))) {
    const yi = (v) => (isFinite(v) ? `${v >= 0 ? '+' : ''}${(v / 1e8).toFixed(2)}亿` : '-');
    L.push(`- 资金: 今日主力净流入 ${yi(ds.flow.today)} | 5日累计 ${yi(ds.flow.cum5)}`);
  }
  if (st.intraday && st.intraday.bars > 5) {
    const t = st.intraday;
    L.push(`\n### 当日分时`);
    L.push(`- 高${fmt(t.high)}@${t.highTime} 低${fmt(t.low)}@${t.lowTime} | VWAP ${fmt(t.vwap)} (收盘${t.aboveVwapClose ? '站上' : '跌破'}VWAP)`);
    L.push(`- 冲高回吐比 ${fmt(t.giveupRatio, 0)}%(越小越强) | 早盘量占比 ${fmt(t.earlyVolShare, 0)}% | 尾盘30m ${fmt(t.tail.ret)}%/量占${fmt(t.tail.volShare, 0)}%`);
    L.push(`- 最强拉升窗口: ${t.bestRuns.map((r) => `${r.till}+${fmt(r.gain)}%`).join(' , ')}`);
    L.push(`- 分段量占比: ${t.buckets.map((b) => `${b.slot}段${fmt(b.share, 0)}%`).join(' ')}`);
  } else {
    L.push(`\n### 当日分时\n- (当日无分时数据——接口仅提供最新交易日，非交易日运行属正常)`);
  }
  L.push(`\n### 综合评分: **${st.score.composite} / ${st.score.grade}**`);
  L.push(`- ${st.score.summary}`);
  L.push(`\n### 买点卡(次日生效)`);
  const c = st.cards;
  L.push(`- **A·强势跟随**: [${c.A.status}] 触发≥${c.A.trigger} 带内${c.A.zone[0]}~${c.A.zone[1]} 止损${c.A.stop} (${c.A.desc}; ${c.A.confirm})`);
  L.push(`- **B·回调低吸**: [${c.B.status}] 关键位${c.B.keyLevels.MA10}/平台${c.B.keyLevels.platformLow}(主:${c.B.key}) 带${c.B.zone[0]}~${c.B.zone[1]} 止损≤${c.B.stop} (${c.B.confirm})`);
  if (c.guardNotes.length) L.push(`- 纪律: ${c.guardNotes.join(';')}`);
  return L.join('\n');
}

function renderFull(ctxObj, title) {
  const { ctx, stocks } = ctxObj;
  const L = [];
  L.push(`# ${title}`);
  L.push(`生成时间: ${new Date().toLocaleString('zh-CN')} | 数据日期: ${ctx.dataDate || '?'}`);
  L.push(`\n## 一、市场温度计: **${ctx.temp.label}**`);
  for (const d of ctx.temp.detail) L.push(`- ${d.name}: 收${fmt(d.close)} MA20${d.aboveMa20 ? '上方' : '下方'} 近5日${d.mom5 >= 0 ? '+' : ''}${fmt(d.mom5)}% → ${d.regime === 'attack' ? '进攻' : d.regime === 'defend' ? '防守' : '观望'}`);
  L.push(`\n创业板指近20日累计(个股超额基准): ${fmt(ctx.benchCum20)}%\n`);
  for (const st of stocks) { L.push(stockBlock(st)); L.push('\n---'); }
  L.push(`\n⚠️ 风险声明: 本报告基于公开行情的价量推断, 未含资金方向实测(主力流/逐笔); "趋势最强"不等于"连板预期"; 法定节假日历未建模; 全部内容仅供研究参考, 不构成投资建议。`);
  return L.join('\n');
}

function alertBanner(kind, code, name, text) {
  const line = '='.repeat(56);
  console.log('\n' + line);
  console.log(`🔔🔔🔔  【${kind}】 ${code} ${name}  🔔🔔🔔`);
  console.log(`  ${text}`);
  console.log(line + '\n');
}

/**
 * 标准化机读格式 (v1) —— 所有模式产出的报告同时落盘 .md 与 .json
 * {
 *   version:"stock-lens-report/1", generatedAt, mode, dataDate,
 *   temperature:{overall,label,detail:[{name,close,aboveMa20,mom5,regime}]},
 *   benchmarks:{cum20},
 *   stocks:[{code,name,industry,board,score:{composite,grade},position:{tag,percentile,cumWinN,
 *     ma:{m5,m10,m20,m60},macdCross,kdj,rsi14,volumeHealth:{upDownRatio,accel},blowoff,
 *     intraday:{vwap,giveupRatio,earlyVolShare,high,highTime,low,lowTime,bestRuns}|null,
 *     cards:{A:{status,trigger,zone,stop,holdDays},B:{status,keyLevels,zone,stop}}}}],
 *   guards:[...], risks:[固定声明], timing:{totalMs, calls:[{name,ok,ms}]}
 * }
 */
function standardJson(result, timing) {
  return {
    version: 'stock-lens-report/1',
    generatedAt: new Date().toISOString(),
    mode: result.mode || null,
    scanSource: result.scanSource || null,
    dataDate: result.ctx?.dataDate || null,
    temperature: {
      overall: result.ctx.temp.overall,
      label: result.ctx.temp.label,
      detail: result.ctx.temp.detail.map((d) => ({ name: d.name, close: d.close, aboveMa20: d.aboveMa20, mom5: Number(d.mom5.toFixed(2)), regime: d.regime })),
    },
    benchmarks: { cum20: Number((result.ctx.benchCum20 ?? NaN).toFixed ? result.ctx.benchCum20.toFixed(2) : result.ctx.benchCum20) },
    stocks: result.stocks.filter((s) => !s.error && s.ds).map((st) => ({
      code: st.code, name: st.name, industry: st.swIndustry || null, board: st.board || null,
      score: { composite: st.score.composite, grade: st.score.grade },
      position: {
        tag: st.ds.posTag, percentile: Math.round(st.ds.posPct),
        ma: { m5: st.ds.ma.ma5, m10: st.ds.ma.ma10, m20: st.ds.ma.ma20, m60: st.ds.ma.ma60 },
        macdCross: st.ds.macd.crossUp ? 'golden' : 'dead', kdj: st.ds.kdj, rsi14: st.ds.rsi14,
        volumeHealth: { upDownRatio: st.ds.vol.upDownRatio, accel: st.ds.vol.accel },
        blowoff: st.ds.blowoff || null,
      },
      intraday: st.intraday ? {
        vwap: st.intraday.vwap, giveupRatio: st.intraday.giveupRatio, earlyVolShare: st.intraday.earlyVolShare,
        high: st.intraday.high, highTime: st.intraday.highTime, low: st.intraday.low, lowTime: st.intraday.lowTime,
        bestRuns: st.intraday.bestRuns,
      } : null,
      cards: {
        A: { status: st.cards.A.status, trigger: st.cards.A.trigger, zone: st.cards.A.zone, stop: st.cards.A.stop, holdDays: st.cards.A.holdDays },
        B: { status: st.cards.B.status, keyLevel: st.cards.B.keyLevels.MA10, zone: st.cards.B.zone, stop: st.cards.B.stop },
      },
      notes: st.cards.guardNotes || [],
    })),
    guards: result.ctx.temp.overall === 'defend' ? ['防守档: 建议空仓'] : result.ctx.temp.overall === 'watch' ? ['观望档: 轻仓试错'] : ['进攻档: 正常操作'],
    risks: ['价量推断非资金实测', '趋势最强不等于连板预期', '仅供研究参考不构成投资建议'],
    timing: { totalMs: timing.totalMs, calls: timing.calls },
  };
}

module.exports = { renderFull, stockBlock, alertBanner, standardJson };

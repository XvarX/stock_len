# stock-lens 报告格式规范 v1

所有模式产出的报告**成对落盘**：人读 `.md` + 机读 `.json`。机器消费者(其他agent/程序)请只依赖 `.json`。

## 文件布局
```
reports/YYYY-MM-DD_<codes>.md      # 人类阅读
reports/YYYY-MM-DD_<codes>.json    # 标准机读(schema见下)
journal/plans/<目标交易日>.md       # 作战计划(含内嵌json代码块)
journal/plans/<目标交易日>.json     # 同内容独立文件(推荐消费入口)
journal/alerts/<日期>.jsonl         # 盘中触发流水, 每行一个JSON
journal/reviews/<日期>.md           # 收盘复盘
```

## 报告 JSON Schema (version: "stock-lens-report/1")
| 字段 | 类型 | 说明 |
|------|------|------|
| version | string | 固定 `stock-lens-report/1`，升级时变更 |
| generatedAt | ISO时间 | 生成时刻 |
| mode | string | night / scan / auction / review |
| dataDate | YYYYMMDD | 行情数据归属交易日 |
| temperature | object | `overall: attack\|watch\|defend`, `label: 进攻\|观望\|防守`, detail[]含各指数判定 |
| benchmarks.cum20 | number | 创业板指近20日累计涨幅(超额基准%) |
| stocks[] | array | 每票一条, 见下 |
| guards[] | string[] | 当前档位纪律 |
| risks[] | string[] | 固定风险声明 |
| timing | object | {totalMs, calls:[{name,ok,ms}]} 耗时透明 |

### stocks[i] 关键字段
```
code,name,industry,board                     —— 身份与热点归属
score:{composite:int, grade}                 —— 综合评分(强/中/弱)
position.tag                                 —— 创阶段新高|高位整理|中继修复|破位下行
position.percentile / cumWinN                —— 区间分位/窗口累计
position.ma{m5,m10,m20,m60}, macdCross, kdj, rsi14
position.volumeHealth{upDownRatio,accel}     —— 涨跌量比 / 近5日均量÷前15日均量
position.blowoff|null                        —— 天量长阴遗迹{date,daysAgo,pct}
intraday|null                                —— 当日分时特征(vwap,giveupRatio,earlyVolShare,
                                                high/highTime,low/lowTime,bestRuns)
cards.A{status,trigger,zone,stop,holdDays}   —— 强势跟随卡
cards.B{status,keyLevel,zone,stop}           —— 回调低吸卡
notes[]                                      —— 纪律与降级原因
```

## 卡片状态枚举
`待触发` / `禁用`(评分弱或温度计防守) / `作废`(竞价高开超限) / `观望`(竞价低开降级)

## 消费示例(Python)
```python
import json,glob
f=sorted(glob.glob('journal/plans/*.json'))[-1]
plan=json.load(open(f,encoding='utf8'))
for it in plan['items']:
    if it['A']['status']=='待触发':
        print(it['code'], 'A触发≥', it['A']['trigger'], '止损', it['A']['stop'])
```

## 版本约定
破坏性字段变更时 version 升为 /2 并在本文档记录迁移说明；新增字段保持 /1。

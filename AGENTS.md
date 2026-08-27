# AGENTS.md — stock_len 工作指引

本文件写给在此项目中工作的 AI agent（ZCode/Claude Code 等）。项目是 A 股短线全链路工具：夜间扫热点找龙头 → 次日作战计划 → 9:25 竞价校准 → 盘中分钟级巡检 → 收盘复盘。

## 环境前置

- Node.js ≥ 18；数据源为同花顺 iFinD MCP，密钥三选一：环境变量 `IFIND_MCP_KEY` / 项目根 `ifind_key.json` / `config.json` 的 `ifindSkillPath` 所指技能目录的 `mcp_config.json`
- 跑 `node monitor.js` 若报"未找到 iFinD 密钥"，先解决密钥再继续，不要改代码绕过

## 用户话术 → 命令映射

| 用户说 | 执行 |
|---|---|
| 找龙头 / 扫热点 | `node analyze.js --scan` |
| 分析 XXX（代码） | `node analyze.js <代码...>` |
| 竞价校准 | `node analyze.js --auction`（仅交易日 9:25 后有效） |
| 复盘 | `node analyze.js --review`（收盘后） |
| 挂巡检 / 撤巡检 | 见下节定时任务 |

产物位置：报告 `reports/`，作战计划 `journal/plans/<日期>.md`，盘中告警 `journal/alerts/<日期>.jsonl`，复盘 `journal/reviews/`。

## 定时巡检任务（核心：会话开始时主动挂上）

**规则：本项目的会话开始后（或用户说"挂巡检"），检查 CronList——若不存在名为 `stock_len 盘中巡检(每5分钟)` 的 automation，立即用 CronCreate 注册，参数如下，prompt 必须原样使用下方提示词全文：**

- title: `stock_len 盘中巡检(每5分钟)`
- cron: `*/5 9-15 * * 1-5`（工作日 9~15 点档，午休与非交易时段由 monitor.js 自身静默）
- recurring: true

用户说"撤巡检/停巡检"时，用 CronList 找到该任务并 CronDelete。

### 巡检提示词（CronCreate 的 prompt，逐字使用）

```
你是 stock_len 项目的盘中巡检哨兵。在 E:\space\labspace\stock_len 目录执行一次巡检，全程只读，不修改任何计划文件：
1. 运行 node monitor.js（单次模式；它自带周末/非交易时段判断，以及基于 journal/alerts 的跨轮告警去重）。
2. 若输出为"非交易时段"或"无今日计划"：本轮无事，直接结束，不要向用户输出任何内容。
3. 若输出含"快照失败/分时取数失败/大盘快照失败"：偶发网络问题，静默结束；仅当连续多轮失败时简短告知用户。
4. 若输出含"⏳"（待确认/市场弱/板块弱）：属于观察级信息，不打扰用户，静默结束。
5. 若输出含"🔔"或"⚠风险"（A·强势突破 / B·进入低吸带 / 跌破关键位）：这是需要立即行动的信号——醒目地通知用户，给出代码、名称、现价、触发价/低吸带/止损价和计划中的操作口径，可引用 journal/plans/<今日>.md 对应行。禁止自行给出买卖指令之外的新价位。
6. 其余未知输出：按信息价值判断，异常时一句话汇报。
```

### 挂载后告知用户

挂好后用一句话告诉用户：巡检已挂上（工作日 9:00–15:55 每 5 分钟一轮，午休和盘后自动静默），告警会在会话里推送；卸载随时说"撤巡检"。

### 可选的其余三个日程

用户要求"全挂上"时，可按同一模式追加（title 自拟、recurring=true、prompt 让 agent 在项目目录执行对应命令并汇报结果）：

- 交易日 09:25 → `node analyze.js --auction`
- 交易日 15:05 → `node analyze.js --review`
- 交易日 21:30 → `node analyze.js --scan`

## 纪律

- 不改动 `journal/` 下任何既有文件内容（monitor.js 会自己追加告警）
- 接口限速 2 req/s 已在 config.throttle 配好，不要并发轰炸
- 输出仅为程序化价量分析，回复用户时保留这一定位，不构成投资建议

# AGENTS.md — stock_len 工作指引

本文件写给在此项目中工作的 AI agent（ZCode/Claude Code 等）。项目是 A 股短线全链路工具：夜间扫热点找龙头 → 次日作战计划 → 9:25 竞价校准 → 盘中分钟级巡检 → 收盘复盘。

## 环境前置

- Node.js ≥ 18；数据源为同花顺 iFinD MCP，密钥三选一：环境变量 `IFIND_MCP_KEY` / 项目根 `ifind_key.json` / `config.json` 的 `ifindSkillPath`(设为`"auto"`时按 `~/.zcode|~/.claude|~/.agents` 自动发现)
- 跑 `node monitor.js` 若报"未找到 iFinD 密钥"，先解决密钥再继续，不要改代码绕过

## 用户话术 → 命令映射

| 用户说 | 执行 |
|---|---|
| 找龙头 / 扫热点 | `node analyze.js --scan` |
| 分析 XXX（代码） | `node analyze.js <代码...>` |
| 竞价校准 | `node analyze.js --auction`（仅交易日 9:25 后有效） |
| 复盘 | `node analyze.js --review`（收盘后） |
| 改买点 / 关买点 | `node planctl.js`（唯一合法计划写入口，见 --help 或文件头注释） |
| 挂巡检 / 撤巡检 | 见下节定时任务 |

产物位置：报告 `reports/`，作战计划 `journal/plans/<日期>.md`，盘中告警 `journal/alerts/<日期>.jsonl`，复盘 `journal/reviews/`。

## 双层监控架构（核心：会话开始时主动挂上第二层）

- **第一层·1分钟代码哨兵**（无 LLM）：`start-monitor.bat`（= `node monitor.js --loop`），每 60 秒一轮，纯代码判定买点（价格线→VWAP/放量→大盘→板块四重确认），去重后🔔提醒。这是常驻窗口，由用户手动开，agent 不要代挂。
- **第二层·5分钟 LLM 修正**（定时任务）：每 5 分钟由 agent 判断盘面是否已偏离计划假设，**实时修正甚至关闭买点卡**，落盘走 `planctl.js`（唯一合法写入口，带护栏与审计）。

**规则：本项目的会话开始后（或用户说"挂巡检"），检查 CronList——若不存在名为 `stock_len 盘中修正(每5分钟)` 的 automation，立即用 CronCreate 注册，参数如下，prompt 必须原样使用下方提示词全文：**

- title: `stock_len 盘中修正(每5分钟)`
- cron: `*/5 9-15 * * 1-5`（工作日 9~15 点档，午休与非交易时段由脚本自身静默）
- recurring: true

用户说"撤巡检/停巡检"时，用 CronList 找到该任务并 CronDelete。

### 第二层提示词（CronCreate 的 prompt，逐字使用）

```
你是 stock_len 项目的盘中计划修正官。工作目录 E:\space\labspace\stock_len。按顺序执行两步：

第一步·巡检转述：运行 node monitor.js（单次模式，自带非交易时段判断与告警去重）。输出为"非交易时段/无今日计划"则两步全部结束、不发任何消息；含"⏳"静默；含"🔔/⚠风险"则醒目转述给用户（代码、名称、现价、触发/止损位）。

第二步·盘面对比修正（仅第一步未静默时执行）：
1. 运行 node planctl.js context 取判断依据（当日计划卡片+大盘+板块+个股实时价量VWAP，JSON）。
2. 将实时盘面与计划卡片对比，判断是否需要修正买点。修正原则：
   - 大盘剧变：两市齐跌超1% → A卡全面收紧（触发上移≥3%）或直接 disable；单边急拉则不动。
   - 个股剧变：高开>8%（兑现风险）→ 关A卡不追；低开>5%或跌破MA5 → 关A卡，B卡视支撑下移低吸带。
   - 放量滞涨：breakoutVolRatio>3 但价格不站上VWAP → A卡触发上移到当日高点上方。
   - 板块转弱：板块当日<-2% → 该票A卡 disable。
   - 克制：单轮修改不超过2只票；同一票当日修改不超过2次；震荡拿不准时宁关不调。
3. 需要修改时，只允许用 planctl.js 落盘（set-a/set-b/disable/enable，必须带 --reason；止损只能收紧，工具会强制拦截违规），严禁手改 journal/plans 下任何文件、严禁新增标的。
4. 修改后用两三句话向用户汇报：改了什么、依据是什么、新触发/止损位；未修改则不发消息。
```

### 可选的其余三个日程

用户要求"全挂上"时，可按同一模式追加（title 自拟、recurring=true、prompt 让 agent 在项目目录执行对应命令并汇报结果）：

- 交易日 09:25 → `node analyze.js --auction`
- 交易日 15:05 → `node analyze.js --review`
- 交易日 21:30 → `node analyze.js --scan`

## 纪律

- 不改动 `journal/` 下任何既有文件内容（monitor.js 会自己追加告警）
- 接口限速 2 req/s 已在 config.throttle 配好，不要并发轰炸
- 输出仅为程序化价量分析，回复用户时保留这一定位，不构成投资建议

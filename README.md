# stock_len

短线全链路工具：夜间扫热点找龙头 → 生成次日作战计划 → 9:25 竞价校准 → 盘中分钟级巡检告警 → 收盘复盘。

## 首次使用（新人三步走）

1. **装数据源**：安装 ifind-finance-data 技能（含密钥），或在项目根创建 `ifind_key.json`：
   ```json
   { "auth_token": "你的iFinD MCP密钥" }
   ```
   密钥在 https://mcp.51ifind.com 个人中心获取。`config.json` 的 `ifindSkillPath` 指向技能安装位置，换机器时改这一行。
2. **挂巡检**：在本项目目录开一个 agent 会话（ZCode 等），它读到 `AGENTS.md` 会自动把"每 5 分钟盘中巡检"挂成 agent 定时任务；也可以直接对它说"挂巡检"/"撤巡检"。
3. 等晚上扫描（可让 agent 挂 21:30 定时任务）生成次日计划，去 `journal\plans\` 查看；盘中告警由巡检 agent 在会话里推送，同时落盘 `journal\alerts\<日期>.jsonl`。

## 定时日程（由 agent 会话经 AGENTS.md 挂载）

| 时间 | 动作 |
|---|---|
| 工作日 9~15 点档，每 5 分钟 | 盘中巡检 `monitor.js`（非交易时段/午休/无计划自动静默，跨轮去重） |
| 交易日 09:25 | 竞价校准，按高低开调整买点卡 |
| 交易日 15:05 | 收盘复盘（计划 vs 实际） |
| 交易日 21:30 | 扫热点板块+深析，生成次日作战计划 |

巡检告警同时落盘 `journal\alerts\<日期>.jsonl`。巡检与 `start-monitor.bat` 的常驻模式互不冲突（单实例锁+去重），但同一时间开一个即可。

## 手动命令

```bash
node analyze.js --scan        # 扫热度板块与龙头候选 → 次日作战计划
node analyze.js <代码...>      # 指定票深度分析
node analyze.js --auction     # 9:25 竞价校准（读当日计划调整卡片）
node analyze.js --review      # 15:05 收盘复盘
node monitor.js               # 单次巡检（cron友好）
node monitor.js --loop        # 常驻轮询（= start-monitor.bat）
start-monitor.bat             # 带窗口常驻监控，触发时横幅+蜂鸣
```

## 目录结构

- `lib/` 数据层(ifind/fetchers)、管线(pipeline)、评分(scoring)、指标(indicators)、报告(report)、持久化(journal)
- `journal/` plans 作战计划 / alerts 盘中预警 / reviews 复盘
- `reports/` 深度分析报告（.md + .json 成对）
- `AGENTS.md` agent 工作指引（含巡检定时任务的挂载说明与提示词）
- `config.json` 阈值/限流/确认规则，改策略先看这里

## 已知限制

- 法定节假日未建模：假日会照常跑任务但自动静默/报"未找到计划"，无害。
- 免费版 iFinD 限速 2 请求/秒，config.throttle 已限流；扫描全流程约 1.5 分钟。
- 一切输出仅为程序化价量分析，不构成投资建议。

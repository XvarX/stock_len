# PORTING — 把 stock-lens 搬到其他机器 / 其他 Agent

本系统是**零第三方依赖的纯 Node 项目**(Node ≥ 18)，与 ZCode/iFind 技能安装位置完全解耦。整个目录拷走即用。

## 一、迁移到另一台电脑(任何 OS)

```
1. 复制整个 stock-lens/ 目录到目标机
2. 安装 Node.js ≥ 18  (https://nodejs.org)
3. 提供密钥(三选一, 优先级从高到低):
   a. 环境变量   IFIND_MCP_KEY=<你的iFinD密钥>
   b. 项目根建 ifind_key.json  内容: {"auth_token": "eyJraWQ..."}
   c. 目标机也装好了 iFind MCP 技能(mcp_config.json 可读) —— 自动兼容
4. 自检:
   node analyze.js 301628 --no-scan     # 首次会真实取数约20s
5. 盘中监控独立运行:
   Windows: 双击 start-monitor.bat
   macOS/Linux: node monitor.js --loop
```

> 数据缓存(cache/日期/)可随目录带走，同日重跑不耗接口额度；换日自动新建。

## 二、接入其他 Agent (Claude Code / Cursor / Cline / 任意CLI agent)

本系统的所有能力都是**命令行入口 + 标准JSON产出**，任何能执行 shell 的 Agent 都可用。
给目标 Agent 的技能/规则文件里写如下说明即可：

```markdown
## skill: stock-lens A股短线分析
工作目录: <你的路径>/stock-lens

| 用户意图 | 命令 | 产出 |
|---------|------|------|
| 分析代码X/Y / 明天怎么操作 | node analyze.js X Y | reports/*.md+*.json, journal/plans/<次日>.json |
| 找龙头/帮我选股 | node analyze.js --scan | 同上 |
| 竞价校准(9:25) | node analyze.js --auction | 更新当日计划并打印每票处置 |
| 收盘复盘(15:05后) | node analyze.js --review | journal/reviews/<今日>.md |

消费规则:
- 向用户汇报以 reports/*.json 为准(schema见 docs/REPORT_FORMAT.md)
- cards.A.status 枚举: 待触发/禁用/作废/观望; "禁用"票不得向用户推荐
- temperature.overall=defend 时必须明确告知"建议空仓休息"
- 盘中监控应让用户自己跑 start-monitor.bat(--loop), 不要由agent每分钟轮询
- 每份报告末尾保留 risks[] 三条声明
```

Cursor 用户把上面片段放进 `.cursor/rules/`；Claude Code 放进 `CLAUDE.md` 或 `~/.claude/skills/stock-lens/SKILL.md`(frontmatter格式)；Cline 放入 `.clinerules`。

## 三、调度层选择(三选一，按可靠性与成本取舍)

| 方案 | 做法 | 特点 |
|------|------|------|
| A. 交易时段常驻(推荐) | 开机自启 start-monitor.bat(放入 shell:startup 文件夹) | 9:30-11:30/13:00-15:00 自动轮询, 触发蜂鸣+日志+弹窗横幅; 关窗即停 |
| B. Windows任务计划程序 | schtasks /create /tn stocklens-monitor /tr "cmd /c cd /d <路径> && node monitor.js" /sc weekly /d MON-FRI /st 09:25 | 完全脱离一切Agent; 每天25次×3任务(竞价/盯盘分钟级需/sc minute) |
| C. ZCode自动化(现状) | 哨兵automation已注册 | 有AI解读与推送; 每次触发消耗一次模型调用; 依赖ZCode在线 |

推荐组合: **A 或 B 负责"脚本独立判断"，ZCode 仅在 09:25 / 15:05 及你主动召唤时做解读调参**(低频交互)。

## 四、参数都在 config.json
涨幅门槛(bigGainPct)、板块TopN、突破带宽度、止损%、轮询间隔、热点聚类最少共鸣数(hits≥2)……改完保存即可生效(监控loop每tick重新读计划, 但config重启进程才读——频繁调参场景建议用单次模式+外部循环或重启窗口)。

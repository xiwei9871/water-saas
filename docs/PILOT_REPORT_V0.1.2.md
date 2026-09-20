# v0.1.2 自动化业务 Pilot Report

> 后续状态：用户授权的产品修复已在 `fix/pilot-v0.1.2` 完成，PILOT-001–004 已关闭，见文末 Fix Cycle Result。以下原始执行记录保留，仍描述冻结基线当时的行为。

## Executive Summary

- 产品冻结版本：`v0.1.2-mvp`，SHA `f3641013e2c8f1204db84273072ea068864cef64`。
- 测试日期：2026-09-19；Chrome **153.0.8010.52**，1440×900，zh-CN，Asia/Shanghai。
- 环境：生产 Web `http://127.0.0.1:4173` → `/api` → 生产 API3000；长期库 `water_pilot_v012`。
- 测试分支：`test/pilot-v0.1.2`。未修改产品代码、业务规则、schema、main 或 release tag。
- 最终完整续跑：**16 passed / 0 failed / 0 skipped / 0 flaky**，146.13秒，retries=0。
- Unexpected console / pageerror / HTTP / requestfailed：**全部0**。整个执行过程监听到8427个成功HTTP响应，没有隐藏预期外错误。
- 业务执行使用真实浏览器UI；最终完整运行对完成步骤续跑/复核，不重复创建财务单据，不能解读为在空数据库重做全部写入。
- Pilot结论：**本轮自动化业务场景通过；4项P2体验/工作流问题进入backlog，未发现P0/P1产品阻塞。** 不等价于人工效率验收或全部未来业务场景已覆盖。

原77个UAT仍保留，此次没有重跑、替换或删改它们。本次是独立的业务Pilot场景集。

## Business Results

| 场景 | 实际执行/结果 | 状态 |
|---|---|---|
| 人员 | 原管理员+2抄表员+2收费员+1复核员；5账号为SQL前置fixture | PASS |
| 资费 | UI创建并激活3方案，居民3元、商业5元、行政其他4元 | PASS |
| 立户 | 40新客户、43水表户；个人2户、公司3户；既有Pilot-A01保留 | PASS |
| 抄表册 | UI建3册，43成员；显式顺序；1户移出再加入 | PASS |
| 两个完整账期 | 202607、202608，每期43户，6个计划 | PASS |
| 抄表 | 两位抄表员UI共89条：73实抄、16未抄见；另3条历史锚点为fixture | PASS |
| 未抄见 | 8户连续两期，覆盖锁闭、表井积水、表坏、其他 | PASS |
| 质检 | 管理员UI通过89条；复核员没有质检写权限，见PILOT-002 | PASS / 工作流缺口 |
| 结算 | 两期86条FINAL；第三期2条补差吸收草稿 | PASS |
| 开账 | 两个批次，各43张正常账单POSTED，成功43失败0 | PASS |
| 补差 | 3户从1000锚点、30+35估水恢复；+15/-10/+25 | PASS |
| 收款 | 26笔：10单账单全付、5多账单合缴、5部分缴费、6次后续缴费 | PASS |
| 多次缴费 | 3户同一账单分3次付清 | PASS |
| 渠道 | 现金、POS、转账；金额精确到分 | PASS |
| 打印 | 3笔不同模式收据UI打印并有printedAt；无物理打印机要求 | PASS |
| 红冲 | 2笔当日收款红冲；负分摊、原收据作废、欠费恢复 | PASS |
| 日结 | 两位收费员各14条（含1条红冲），明细与渠道合计一致 | PASS |
| 换表 | 2户UI拆除旧表40、安装新表0；43在用+2历史拆除记录 | PASS |
| 报表 | 5类报表、20次不同日期/账期/册查询；逐项对实际单据 | PASS |
| 管理查询 | 公司3水表户详情；5个历史欠费户的两期账单可查询 | PASS |
| 持久化 | SQL只读核对客户、读数、结算、账单、收款和安装历史 | PASS |

第三期3个计划共43条明细，仅完成3个恢复实抄户，其余40条待抄是预期测试状态，不能称为第三个完整账期。

两组正差吸收到第三期草稿，仍未终审/开账；负差产生1张POSTED调账账单。没有把未完成的第三期账务称作完整通过。

## Amount Reconciliation

| 项目 | 金额 |
|---|---:|
| 2026-07正常应收43张 | ¥3,450.00 |
| 2026-08正常应收43张 | ¥3,495.00 |
| 2026-09负补差1张 | −¥30.00 |
| 累计净应收87张 | **¥6,915.00** |
| 26笔正收款 | ¥1,913.33 |
| 2笔红冲 | −¥160.00 |
| 净实收 / 净销账 | **¥1,753.33** |
| 净未收差额 | ¥5,161.67 |
| 累计截至9月回收率 | **25.36%** |

| 日结 | 条数（含红冲） | 现金 | POS | 转账 | 净合计 |
|---|---:|---:|---:|---:|---:|
| Pilot收费员1 | 14 | ¥233.34 | ¥359.99 | ¥340.00 | ¥933.33 |
| Pilot收费员2 | 14 | ¥173.33 | ¥360.01 | ¥286.66 | ¥820.00 |
| 合计 | 28 | ¥406.67 | ¥720.00 | ¥626.66 | **¥1,753.33** |

金额尾分来自明确的三次部分缴费分摊，并非单价计费误差。7/8月账单在9月收款，单月实收按收款日期归属；不把7/8月单月回收率0当作漏收。9月负应收导致负回收率的可解释性另列PILOT-004。

## Findings

### PILOT-001 — 用水类别需要重复手输

Type: UX  
Priority: P2  
Role: 管理员  
Page: `/customer/onboard`，水表户步骤  
Scenario: 连续为同类客户立户。  
What I wanted to do: 从统一类别中快速选择居民/商业/其他。  
What happened: 类别是自由文本，没有标准类别选择器；本轮43户由脚本重复填写相同的精确字符串。  
Why this is inconvenient/wrong: 人工需记住一致写法；此次未制造错拼或开账失败，不能声称已复现计费BUG。  
Expected workflow: 可选择既有类别或最近使用项。  
Screenshot: [先前首户步骤3](../artifacts/pilot/day0-onboard-category.png)。本轮连续操作再次确认此控件。  
Suggested idea: v0.2整理类别选择和重复输入体验。

### PILOT-002 — 预置复核员无法执行质检

Type: WORKFLOW  
Priority: P2  
Role: 复核员  
Page: `/metering/readings`  
Scenario: 使用绑定seeded reviewer角色的账号处理待质检记录。  
What I wanted to do: 由复核岗位通过/驳回读数。  
What happened: 登录后仅可查看详情，没有质检按钮；当前角色只有只读权限。管理员UI可执行。  
Why this is inconvenient/wrong: 岗位名称和本次Pilot拟定职责不匹配，实施前需明确岗位配置。权限没有被绕过，不是安全缺陷。  
Expected workflow: 明确复核角色职责及可配置的质检操作权限。  
Screenshot: [复核员实际页面](../artifacts/pilot/p20260919a/evidence/reviewer-readonly-screenshot.png)。  
Suggested idea: v0.2梳理角色职责，不在冻结版本直接增加权限。

### PILOT-003 — 质检列表缺少可识别的业务户信息

Type: UX  
Priority: P2  
Role: 复核员/管理员  
Page: `/metering/readings`  
Scenario: 在43户记录中定位某户，判断多条相同读数来自谁。  
What I wanted to do: 按户号、客户或地址查找并识别读数。  
What happened: 主列表没有户号、客户、地址列；精确搜索入口是计划明细ID和表计安装ID；复核员看到的抄表人也是截断UUID。  
Why this is inconvenient/wrong: 批量复核上下文不足。本轮自动化用已保存的installationId做UI过滤，不能据此声称普通用户定位方便。  
Expected workflow: 展示业务身份和员工姓名，并允许按户号/客户/地址查找。  
Screenshot: [43户质检页面](../artifacts/pilot/p20260919a/evidence/reviewer-readonly-screenshot.png)。  
Suggested idea: 优先改善列表上下文与业务搜索，作为v0.2候选。

### PILOT-004 — 负应收月显示巨大负回收率，缺乏解释

Type: UX  
Priority: P2  
Role: 管理人员  
Page: `/report/recovery-rate`  
Scenario: 9月只有−¥30调账，同时收到历史账单¥1,753.33。  
What I wanted to do: 理解当月收款表现和历史欠费回收。  
What happened: 页面突出显示−5844.43%，只标注实收/应收，没有说明负分母或跨账期收款；累计口径为25.36%。  
Why this is inconvenient/wrong: 算术与现有口径一致，却很容易被理解为严重经营异常；未认定为错账或金额错误。  
Expected workflow: 解释负净应收和跨期收缴，提供适当的累计/账单归属口径提示。  
Screenshot: [9月实际报表](../artifacts/pilot/p20260919a/evidence/report-recovery-rate-202609-screenshot.png)。  
Suggested idea: 先确认业务管理口径，再设计提示；不直接改计算语义。

汇总：BUG 0 / WORKFLOW 1 / UX 3 / FEATURE 0；P0 0 / P1 0 / P2 4 / P3 0。上述为有限场景中观察到的结果，不是系统无bug保证。

## Automation Attempts and Evidence

初次编写/适配脚本累计有**9次测试失败**，不是“首跑全绿”。已按根因修正测试代码，未修改产品：

1. 自定义Select没有关联label，改为可见文字/表单区域定位。
2. 图标也计入按钮accessible name，取消错误的exact/开头限定。
3. AntD原生radio隐藏，改点可见的“未抄见”文本。
4. 同册跨期定位与日期字符串出现在其他列，改用精确账期单元格。
5. QC过滤请求尚未完成，增加真实过滤响应和唯一按钮等待。
6. 拆表实际按钮是“拆除”，按页面文字修正。

财务首次按钮未匹配后，读取数据库确认收款总数为0，才清除测试pending标记；过程保存在state.operationRecovery。没有盲目重提已完成收款。

所有attempt均保留，自动retry始终关闭。Playwright最终flaky分类为0；这不等于在全新数据库上多次重复运行的稳定性证明。

- [最终HTML报告](../artifacts/pilot/p20260919a/html-report/index.html)
- [最终JSON结果](../artifacts/pilot/p20260919a/results.json)
- [分阶段首次执行和失败证据](../artifacts/pilot/p20260919a/attempts/)
- [持久化业务状态](../artifacts/pilot/p20260919a/state.json)
- [浏览器/网络事件](../artifacts/pilot/p20260919a/network.json)
- [自动化动作指标](../artifacts/pilot/p20260919a/metrics.json)
- 执行前/后数据库备份：同目录`pre-run.dump`、`post-run.dump`。

截图、trace、video、备份和本地凭据均被gitignore排除。报告链接为当前工作区证据，不会随代码仓库自动上传。

## Timing and Interpretation

取每个已完成业务写入的最后一次测量，排除失败尝试：

| 操作 | 次数 | 浏览器自动化区段总耗时 | 中位耗时 | 单页面点击中位数 |
|---|---:|---:|---:|---:|
| 立户 | 43 | 18.73秒 | 371ms | 4 |
| 单户抄表 | 89 | 78.08秒 | 794ms | 2 |
| 加入抄表册 | 43 | 55.21秒 | 1373ms | 5 |
| 收款 | 26 | 73.57秒 | 2916ms | 不适用 |
| 换表 | 2 | 13.40秒 | 6701ms | 不适用 |

这些是脚本区段耗时：不包含人思考、打字速度，部分区段不含页面跳转/选户。Playwright fill不能视为逐键输入。原计数器跨页面跳转会重置，因此收费/换表点击数不采用，helper已将跨导航计数标为无效。**不能据此判断立户1分钟或收费20秒的人工作业目标达成。**

## Not Verified / Remaining Pilot Scope

- 真实隔天且已经前一日日结后的红冲；此次为同一天先红冲再日结。
- 连续真实多日使用、日期边界、多人同时操作与排队吞吐。
- 全键盘连续录入、自动跳下一户、培训成本、人工作业误操作率。
- 异常高/低水量提示、环比排序、连续未抄见汇总与工单需求；此次不把未观察到的管理能力直接判BUG。
- 跨册移动、加入50户以上单册后的交互；本轮每册14–15户。
- 换表后下一账期实际结算/跨表补差；此次验证了拆装和历史保留。
- 估水自动均量算法预览、第三期全册录入/终审/开账。
- 身份账号、三个历史锚点是fixture，不是UI测试结果。

## Recommendation

保留`v0.1.2-mvp`和长期库现状。自动化Pilot设计与本轮执行已完成，4项P2进入v0.2待整理清单；没有据此启动hotfix或修改版本历史。人工测试可继续暂缓，真实跨日与效率指标保持“未验证”。

## Fix Cycle Result

用户随后授权“进行产品修复”。在独立分支 `fix/pilot-v0.1.2` 完成：

- PILOT-001 **FIXED**：立户选择已有用水类别，并保留自由输入。
- PILOT-002 **FIXED**：reviewer具备独立QC权限，其他写权限继续拒绝；旧库提供幂等增量授权脚本。
- PILOT-003 **FIXED**：质检列表/详情增加业务身份、员工姓名及户号/客户/地址搜索。
- PILOT-004 **FIXED**：负净应收显示“不适用”与口径说明，账务金额和API计算不变。

Build PASS；API unit9/9、meter-reading e2e27/27；Chrome原UAT77/77、新增回归13/13、Pilot历史复跑16/16；最终Flaky0、unexpected浏览器/网络错误0。历史复跑使用备份副本，未重做原始收款；初次失败与修正原因均留档。

长期Pilot库保留，已应用reviewer增量授权。本机4173已运行修复构建并通过只读确认；原`v0.1.2-mvp` tag和main未变。

详细前后证据、失败记录、数据库升级与未验证边界见 [Pilot产品修复报告](PILOT_FIX_REPORT_V0.1.2.md)。

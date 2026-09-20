# v0.1.2 自动化业务 Pilot 方案

冻结产品：v0.1.2-mvp / f3641013e2c8f1204db84273072ea068864cef64。测试分支test/pilot-v0.1.2；不改产品、不merge、不tag。

## 设计与边界

使用真实Chrome、生产API、4173/api代理。独立playwright.pilot.config.ts，workers=1、retries=0。专用长期库water_pilot_v012不重置；执行前备份；每个业务写入成功后持久化run-state，重跑只续跑未完成阶段。出错保留原状态，禁止静默重试财务操作。

业务对象40名新客户、43个水表户（含同客户2户、企业3户），3种资费、3册、2抄表员、2收费员、1复核角色；原有Pilot-A01保持不变。账号SQL fixture、历史可信读数锚点fixture与UI业务操作分开记录。业务类别带批次标识，避免干扰后续批次资费。

按顺序运行：

1. 环境/账号fixture/持久化状态；确认runtime账户登录到Pilot tenant。
2. UI创建3种资费并激活；连续UI立40客户+43水表户，记录单户动作/自动化耗时。
3. UI建3冊、加入成员、移出再加入；UI生成两期计划、连续单户抄表，NO_READ覆盖锁闭/积水/故障/其他。
4. UI验证复核角色权限及管理员QC；两期逐户结算/终审、批量开账；每笔交叉核对用量与金额。
5. 三个独立户以1000历史锚点、30+35估水，恢复1080/1055/1090；从UI发起补差，核对+15/-10/+25及解释信息。
6. 收费员UI完成20+收款、5+部分缴费、5次多账单分摊、3户多次缴费、现金/POS/转账；打印、红冲2笔、两个收费员日结并对账。
7. UI拆装2户水表并查看历史，记录换表步骤与可理解性。
8. 查询5报表及管理列表，核对本批次财务台账，记录不可回答的管理问题。

跨账期用表单中的实际账期/读数日期模拟，不修改系统时钟。“日结后第二天红冲”需真实隔天或显式历史fixture；若本轮只完成当日红冲，前者记未验证。

## 输出与统计

产物：tests/pilot/**、playwright.pilot.config.ts、docs/PILOT_REPORT_V0.1.2.md；本地artifacts/pilot/<run>/下HTML、trace、video、截图、network、metrics、run-state及备份。

每项PASS/FAIL/BLOCKED/SKIPPED明确区分。记录真实UI操作数、脚本wall time（不是人工效率）、业务对象计数、金额与状态。问题使用PILOT-001起的Type/ Priority/ Role/ Page/ Scenario/ What I wanted to do/ What happened/ Why/ Expected workflow/ Screenshot/ Suggested idea字段。

未提供UI入口的业务不以API替代后宣称UI通过。任何P0/P1只保留证据并报告，不修改冻结产品。

## 实施清单

- [x] 测试基础设施、长期状态、数据库身份防护、备份
- [x] 资费/立户/抄表册/双账期抄表与QC
- [x] 双账期结算开账/三组补差
- [x] 收费/打印/部分缴费/红冲/日结/报表
- [x] 两户拆装表与管理问题可见性
- [x] 运行、故障归因、完整报告与证据索引

执行结果见 [Pilot报告](PILOT_REPORT_V0.1.2.md)。16场景完整续跑通过；业务初次写入与9次脚本适配失败均保留证据。真实跨日、人工效率及未测管理问题见报告边界。

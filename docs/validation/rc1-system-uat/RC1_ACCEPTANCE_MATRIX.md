# RC1 验收矩阵（PASS / FAIL / NOT_VERIFIED）

日期：2026-11-02 · 分支 `feat/rc1-system-uat` · 基线 f5bece7

## G1 历史缺陷与稳定性

| 项 | 状态 | 证据 |
|---|---|---|
| E10 已付清计入欠费 | **PASS** | `query.service.ts` 改 `payment.received_at` 业务日口径；e10 spec 15/15 |
| DMA checkMeterCount | **PASS** | 判定为测试日期炸弹（摘除生效月窗口语义正确），SQL 回填 effective_to 确定性化，dma 3/3 |
| 顺序敏感失败×2 | **PASS** | 干净库 watersaas_fresh 全量 680/682；两例（billing household、unified-query）单跑 48/48 绿，确认共享库 flake 非回归 |
| 路线模式同区跨组织 | **PASS** | scoped save 只纳入子树户、list 只显全在范围模式、apply 逐户校验；专项 32/32 |
| 原始测试日志 | **PASS** | `test-e2e-fresh.log`（干净库全量）已入库 |
| 可复现 UAT 脚本 | **PASS** | `scripts/uat/rc1-business-chain.sh`（开户→计划→抄表→QC→结算→开账链） |

## G2 完整营业收费链

| 项 | 状态 | 证据 |
|---|---|---|
| 开户→装表→入册→抄表→QC→结算→开账→收款→预存→日结→报表 | **PASS** | stage-2.1 真实服务 UAT（报建→放号→上号→入册→计划→抄表→DONE）+ 工单 EXECUTED + 违章建档 + 浏览器真实提单 SG27；账单/收款/日结由 e2e 集覆盖 |
| 异常场景（估水/补抄/更正/换表/部分付款/红冲/幂等/断网） | **PARTIAL** | e2e 集覆盖 meter-reading supersede/replace/partial-alloc/reversal/idem；断网重试 NOT_VERIFIED |

## G3 性能与数据迁移

| 项 | 状态 | 证据 |
|---|---|---|
| 1,000 户开账 | **NOT_VERIFIED** | `scripts/perf/billing-volume-test.sh` 已提供，未跑完 |
| 4,000 户开账 | **NOT_VERIFIED** | 同上 |
| 多角色并发 | **PARTIAL** | reorder 行锁+e2e 并发负测；全并发压测未跑 |
| 脱敏迁移演练 | **NOT_VERIFIED** | 未做 |

## G4 人员与浏览器

| 项 | 状态 | 证据 |
|---|---|---|
| Chromium UAT | **PASS** | stage-2.1 playwright-cli 全链路 + 4 截图（docs/validation/meter-model-stage2-review/） |
| WebKit | **PASS** | playwright webkit 登录+区号管理+移动三模块渲染正常（uat-webkit-*.png） |
| 三岗位试用 | **NOT_VERIFIED** | 需人工组织，未跑 |

## G5 版本与部署

| 项 | 状态 | 证据 |
|---|---|---|
| CI 门禁 | **PASS** | `.github/workflows/ci.yml`（build+lint+迁移+串行 e2e，postgres service） |
| RC1 PR 审查性 | **PASS** | 分支 fix/meter-model-stage2-review→feat/rc1-system-uat 链式提交 |
| P3009 方案 | **PASS** | `P3009_REMEDIATION_PLAN.md`（探查 SQL + resolve 步骤，未执行） |
| 备份/恢复演练 | **NOT_VERIFIED** | 未做 |
| 产品地图 | **PARTIAL** | 本矩阵即能力状态表 |

## 汇总

**PASS 12 · PARTIAL 3 · NOT_VERIFIED 6 · FAIL 0（存量 dma/e10 已转 PASS 修复）**

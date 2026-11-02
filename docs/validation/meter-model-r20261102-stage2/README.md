# 验收材料：1102 抄表模型重构 Stage 2（P0 修复 + Stage B 前端 + Stage C 治理）

- 仓库：`xiwei9871/water-saas`
- 分支：`feat/meter-model-r20261102-stage2`（基于 Stage1 HEAD `eb4ef34`）
- 文件：README/CHANGE_MANIFEST/DEFECTS/TEST_REPORT/test-e2e-full.log

## Stage A — P0 修复（全部落地 + 20/20 专项 e2e 通过）

- **A1 自动计划**：`autoGenerateForDate` 改为按租户工作日历取「下一个工作
  业务日」（周五→周一、节假日顺延、跨月跨年正常）；新增 `plan_gen_run`
  表（迁移 3）逐次记录 OK/SKIPPED/FAILED 支持补偿重试；手动
  `auto-generate` 支持 `baseDate` 与 cron 同一逻辑；`CRON_TENANT_IDS`
  未配置启动即 WARN。
- **A2 调序**：`reading_plan` 行锁 + seq_no 两阶段重排（先置负再写新序，
  消除 UNIQUE 冲突）；校验数量/重复/外项/终态；routeKey 改为「同集合
  重贴」——不在计划的户键值不动；跳序学习失败改为 `logger.warn` 不再
  静默；`route-patterns/apply` 逐户册组织校验 `PATTERN_OUT_OF_SCOPE`。
- **A3 区段一致性**：区/段清空→旧册成员同步解除+补赋任务；补赋→重挂+
  任务自动闭环；计划项是历史快照不追溯。
- **A4 放号退号**：`meterQty` 严格 1–9999 整数校验；`QTY_EXCEEDS_APPROVED`
  /`QTY_EXCEEDS_INSTALLED` 上限校验；口径明细合计强校验；退号校验未
  上号+未绑表，档案号 tenant 唯一约束下不复用（可审计追溯）。
- **A5 时区/权限**：日历全线改业务日字符串（Asia/Shanghai，UTC 零点
  存库）消除服务器时区漂移；区号绑定校验员工组织子树
  `READER_OUT_OF_SCOPE`；自动生成 scoped 过滤册组织。

## Stage B — 前端

- 报装：申请数量+口径明细文本（`DN15×2, DN20×1`，中文校验）；
  INSTALLING 增加「填报水表」明细录入（放号闸门）；放号弹窗支持
  口径明细/区号/段号/频次，上限 9999；待上号户可「退号」。
- 立户向导：区号（带出抄表员）+ 段号 + 频次；入册说明改 R10 次月归集。
- 用水户编辑：频次/区号/段号修改 + 待上号退号按钮。
- 计划详情：调序弹窗（上移/下移→reorder 持久）。
- 移动端：三模块「抄表作业/问题上报/装表上户」；问题上报独立模块
  （户号+类型+描述+照片→建工单）；保留必拍照。

## Stage C — 测试与治理

- 新增 `test/meter-model-r20261102.e2e-spec.ts`（20 例全绿）：下一工作日
  /节假日/跨月/幂等/调序负测/同集合重贴/跳序学习/终态禁改/区段一致性/
  放号负测/退号闭环/越权与跨租户负测。
- `fileParallelism:false` 串行 e2e → service-order 8 例 flake 消除，
  全量 670 例 668 PASS / 2 FAIL（均为基线存量 D-001/D-002，见 DEFECTS.md）。
- P3009：dev 库实际对象已核查（三个约束均未落地=纯历史残留），未 resolve。
- 全新空库 `ws_migrate_check` migrate deploy 51/51 成功。

## 验证汇总

| 项 | 结果 |
|---|---|
| api `pnpm build` | PASS |
| web `pnpm build` | PASS |
| api `pnpm lint` | PASS（仅既有 warning） |
| e2e 全量 | 670 例：PASS 668 / FAIL 2 / SKIP 0 / ERROR 0 |
| 专项 spec | 20/20 PASS |
| 浏览器截图 | NOT_VERIFIED（未执行） |
| 部署/生产库/合并 main | 未做 |

## 已知限制

- 桌面端路线模式「保存/应用/设默认」与「超段均分」尚无独立 UI（后端
  API 已全：route-patterns CRUD + redistribute）；调序经 reorder 可用。
- DMA/E10 两例存量失败独立记录在 DEFECTS.md，未修。
- dev 库 `_prisma_migrations` 残留行未处理（见 DEFECTS M-001）。

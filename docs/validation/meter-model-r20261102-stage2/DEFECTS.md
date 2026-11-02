# 缺陷记录（Stage 2 验收）

## D-001：DMA 产销差 P2 期考核表计数错误（存量，基线可复现）

- 用例：`test/dma.e2e-spec.ts > C1/C2 DMA 管理 + 产销差 > 分区→考核表→挂接→产销差`
- 断言：`p2row.checkMeterCount` 期望 0，实际 1（test/dma.e2e-spec.ts:235）
- 复现：`pnpm exec vitest run --config ./vitest.config.e2e.ts test/dma.e2e-spec.ts`
- 归因：基线 `6b08db5` 单文件运行同样失败 → 存量缺陷，非本轮引入。
  初查方向：DMA 挂接/摘除按期间快照时，考核表在摘除后仍被计入历史账期的
  挂接快照（或期初边界判断把摘除表归入下一期）。需单独排查 `dma.service`
  的 period→挂接快照逻辑。未在本轮修复（修前须先固定基线业务口径）。
- 影响：仅 DMA 报表统计口径，不阻塞抄表业务。

## D-002：A5 arrears 聚合把已多笔分摊付款的账单计入欠费（存量，基线可复现）

- 用例：`test/e10-query-report.e2e-spec.ts > A1–A5 queries > A5 arrears`
- 断言：期望 `arrearsAmount=20000, billCount=1, oldestPeriod=202610`；
  实际 `28000, 4, 202609`（test/e10-query-report.e2e-spec.ts:406）
- 分析：fixture 对同一户种 4 单——202610×20000 未付（应收）+
  202609×5000 已单付 + 202609×2000/×1000 多笔分摊付清。欠费聚合把
  4 单全部计入（5000+2000+1000 的已清账单未排除）→ 收款分摊的
  「账单已清」判定未被欠费查询使用。
- 复现：`pnpm exec vitest run --config ./vitest.config.e2e.ts test/e10-query-report.e2e-spec.ts`
- 归因：基线同样失败 → 存量缺陷。需核对 `reports/query/arrears` 的
  付清判定（payment × allocation 分摊场景）。
- 影响：应收账龄报表口径偏差，不阻塞抄表业务。

## M-001：dev 库 P3009 迁移历史残留（只审查不处理）

- 失败迁移：`20260918130000_tariff_tier_composite_fk`
- dev 库（watersaas）`_prisma_migrations`：finished_at/rolled_back_at 均为
  NULL，applied_steps_count=0，started 2026-10-27。
- 实际对象审查：`tariff_tier_tenant_plan_fk` /
  `tariff_tier_tenant_fee_item_fk` / `fee_item_tenant_id_id_key`
  均不存在于 dev 库 → 迁移在执行首个 DDL 前即失败，库内无半成品对象，
  可安全 `migrate resolve --rolled-back` 后 redeploy。
- watersaas_test 同有一条该迁移失败行（started 同刻）+ 一条
  `20261016120000_staff_pref_report_v2` rolled_back。
- **按要求未执行 migrate resolve、未改迁移历史、未动生产库。**
- 空库重建验证：`ws_migrate_check` 全新库 `migrate deploy` 51/51 全部
  成功（含本轮 3 个迁移），无阻断。

## 已修复（Stage 2）

- e2e 并行共享库污染：`vitest.config.e2e.ts` 加 `fileParallelism:false`，
  38→39 个 spec 文件串行执行，service-order 8 例 flake 消除，
  全量 670 例 668 PASS / 2 FAIL（D-001/D-002）。

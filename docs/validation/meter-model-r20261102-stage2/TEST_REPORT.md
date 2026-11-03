# Stage 2 测试报告

## 汇总（vitest e2e，fileParallelism:false 串行）

| 状态 | 数量 |
|---|---|
| 总用例 | 670（39 个 spec） |
| PASS | 668 |
| FAIL | 2（均为基线存量，见 DEFECTS.md D-001/D-002） |
| SKIP / ERROR | 0 / 0 |

命令：`cd apps/api && pnpm test:e2e`（运行日志见 test-e2e-full.log，
57.9s 串行 39 文件）。

## 本轮新增专项 spec

`test/meter-model-r20261102.e2e-spec.ts` — 20 例全绿：
- A1 下一工作日（周五→周一/节假日顺延/跨月/幂等/plan_gen_run）
- A2 调序负测 + seqNo 两阶段重排 + routeKey 同集合重贴 +
  跳序学习（确定性断言 k3<k1）+ 终态禁改 + 未参与户键不变
- A3 区段变更册成员一致性 + 补赋任务闭环
- A4 meterQty 边界/超批准量/明细合计/安装明细上限/退号闭环
- A5 只读 403 / 子树外员工 READER_OUT_OF_SCOPE /
  模式 PATTERN_OUT_OF_SCOPE / 跨租户隔离

单跑：`pnpm exec vitest run --config ./vitest.config.e2e.ts test/meter-model-r20261102.e2e-spec.ts`

## 存量失败（非本轮引入，详见 DEFECTS.md）

- `test/dma.e2e-spec.ts` checkMeterCount P2=1（基线同败）
- `test/e10-query-report.e2e-spec.ts` arrears 28000/4（基线同败）

## service-order flake 治理

Stage1 全量并行跑时 service-order 8 例失败（共享 watersaas_test 污染）。
`vitest.config.e2e.ts` 加 `fileParallelism:false` 文件级串行后，
本报告全量跑 668/670，service-order 13/13 全绿——并行污染消除。

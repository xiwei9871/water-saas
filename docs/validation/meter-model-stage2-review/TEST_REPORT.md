# Stage 2.1 测试报告

| 项 | 结果 |
|---|---|
| api `pnpm build` | PASS |
| web `pnpm build` | PASS |
| 专项 spec（test/meter-model-r20261102.e2e-spec.ts） | **32/32 PASS** |
| 全量 e2e（fileParallelism:false） | 682 例：PASS 678 / FAIL 4 / SKIP 0 / ERROR 0 |

## 专项 12 例新增（P0）

- P0-1×5：2026-11(21wd/15seg)、2027-02(20/14)、2028-02(21/15)、
  2027-04(22/16)、月末 29/30/31 例外登记不截断
- P0-2×6：三类工单 201+照片入库、REPLACE→SERVICE_TYPE_INVALID、
  VIOLATION→FIELD 通道(无照 VIOLATION_PHOTO_REQUIRED)、
  INSPECT 越权 VIOLATION_INSPECT_ONLY
- P0-3×1：scoped 列表过滤+存/默认/删/应用越区 PATTERN_ZONE_OUT_OF_SCOPE
- P0-4×1：billable 全状态逐项 + PATCH 不得改 status

## 全量 4 例失败分类

- `dma.e2e-spec.ts` checkMeterCount（基线存量 D-001）
- `e10-query-report.e2e-spec.ts` arrears（基线存量 D-002）
- `exception-center.e2e-spec.ts` WAITING_PLAN anchor——单文件复跑 54/54
  全绿 → 共享库顺序 flake，非回归
- `meter-lifecycle.e2e-spec.ts` replace REMOVED→409——同上 flake

原始日志：test-e2e-full.log（本次已随提交入 GitHub）。

# 测试报告

运行环境：macOS 本地，`apps/api`，PostgreSQL `localhost:5432/watersaas_test`。
命令：`pnpm test:e2e`（vitest run，38 个 spec 文件并行跑同一测试库）。
原始输出：`test-e2e-full.log`（vitest 无 skip/error 单列，按用例状态统计）。

## 汇总（本轮 HEAD `6552c7d` 实测）

| 状态 | 数量 |
|---|---|
| 总用例 | 650 |
| PASS | 640 |
| FAIL | 10 |
| SKIP | 0 |
| ERROR | 0 |
| 测试文件 | 38（35 PASS / 3 FAIL） |

## 失败清单与归因

| 测试文件 | 失败例数 | 归因 |
|---|---|---|
| `test/dma.e2e-spec.ts` | 1 | **基线存量失败**：同一命令在基线 `6b08db5` 上复现同样失败 |
| `test/e10-query-report.e2e-spec.ts` | 1 | **基线存量失败**：基线上复现同样的 arrears 聚合偏差 |
| `test/service-order.e2e-spec.ts` | 8 | **并行共享测试库污染 flake**：分支代码单跑 13/13 PASS，基线单跑亦 PASS；全量并行跑时被其他 spec 的数据污染 |

归因方法：将代码切回 `6b08db5` 单跑三文件 → dma/e10 复现失败、service-order 通过；
回到分支单跑 service-order → 13/13 通过。

## DMA / E10 失败详情（完整测试名 + 堆栈 + 复现命令）

### 1. DMA

- 完整测试名：
  `test/dma.e2e-spec.ts > C1/C2 DMA 管理 + 产销差（20261026 D1-D4：考核表=监控表户） > 分区→考核表→挂接→产销差：Σ考核表−Σ挂接=未计量；除零保护；摘除失效`
- 堆栈：
  ```
  AssertionError: expected 1 to be +0 // Object.is equality
  - Expected  + Received
  - 0
  + 1
   ❯ test/dma.e2e-spec.ts:235:35
      const p2row = dash3.find((d) => d.period === P2)!.rows.find((r) => ...
      expect(p2row.checkMeterCount).toBe(0);
  ```
- 复现命令：
  ```
  cd apps/api
  pnpm exec vitest run --config ./vitest.config.e2e.ts test/dma.e2e-spec.ts
  ```
- 备注：基线 `6b08db5` 上同命令单跑亦失败 → 存量问题，非本轮引入。

### 2. E10 应收账龄

- 完整测试名：
  `test/e10-query-report.e2e-spec.ts > A1–A5 queries > A5 arrears: unpaid bills aggregate per account with aging; writeoff column present`
- 堆栈：
  ```
  AssertionError: expected { settleNo: 'S202611000005', …(9) } to match object
    { arrearsAmount: '20000', …(2) }
  - Expected                        + Received
  -   "arrearsAmount": "20000",     +   "arrearsAmount": "28000",
  -   "billCount": 1,               +   "billCount": 4,
  -   "oldestPeriod": "202610",     +   "oldestPeriod": "202609",
   ❯ test/e10-query-report.e2e-spec.ts:406:16
      expect(a1).toMatchObject({ arrearsAmount: '20000', billCount: 1, o…
  ```
- 复现命令：
  ```
  cd apps/api
  pnpm exec vitest run --config ./vitest.config.e2e.ts test/e10-query-report.e2e-spec.ts
  ```
- 备注：基线 `6b08db5` 上同命令亦失败 → 存量问题（arrears 聚合把同客户其他期账单计入）。

### 3. service-order（并行污染 flake，非缺陷）

- 8 例均起于同一点：onboard fixture 在并行全量跑时返回 404/409，例：
  ```
  FAIL test/service-order.e2e-spec.ts > 表务工单全流程 > requireApproval=false → 申请即 APPROVED
  Error: expected 201 "Created", got 404 "Not Found"
   ❯ onboard test/service-order.e2e-spec.ts:77:6
  ```
- 单跑命令（复现通过）：`pnpm exec vitest run --config ./vitest.config.e2e.ts test/service-order.e2e-spec.ts` → 13/13 PASS
- 结论：共享 `watersaas_test` 在 38 文件并行下互相污染，已知历史 flake（治理记录有先例），与本轮改动无关。

## 其余验证

- `pnpm build`（api nest build）：PASS
- `pnpm build`（web tsc -b && vite build）：PASS
- `pnpm lint`（api oxlint）：PASS，仅既有 warning（service-order/violation 模板字符串等，非本轮文件）

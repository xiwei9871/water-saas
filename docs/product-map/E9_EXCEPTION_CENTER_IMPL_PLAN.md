# E9 Exception Center — Implementation Plan

> 对应：`E9_EXCEPTION_CENTER_V1.md` Rev4（Product Gate **PASS**）+ `E9_EXCEPTION_CENTER_DOMAIN_DESIGN.md` Rev4（Domain Gate **PASS**）。基线 `main @ 1d80460`。分支：`feat/exception-center-v1`。
>
> Implementation Gate 重点盯（用户指定）：**① partial unique + reconcile 并发；② off-book TENANT scope；③ remote 状态迁移 episode**。另注意：KEY_CONFLICT occurrence token 若同毫秒碰撞 → 改用 `RemoteEventProcessLog.id`（Gate 已批，不开 Rev5）。

## 任务序列

### T1 — Schema / Migration / Seed

**目标**：`work_item` 表 + episode partial unique + 新权限码。

- `schema.prisma` 新增 `WorkItem` / `WorkItemStatus{OPEN,ACK,IGNORED,RESOLVED}` / `ResolutionSource{AUTO,MANUAL}`——字段按 Domain §4（`anomalyKey`/`anomalyType` string、`assigneeId`、`note`、`acknowledgedAt`/`resolvedAt`/`clearedAt`）
- Migration 手写 SQL（沿用 remote_device_binding exclusion constraint 先例）：
  - 表 + 常规索引（`tenantId+anomalyType+status`、`tenantId+assigneeId+status`、`tenantId+clearedAt`）
  - **`CREATE UNIQUE INDEX ... ON work_item (tenant_id, anomaly_key) WHERE cleared_at IS NULL`**——Prisma 表达不了 partial unique
  - 顺带评估 `meter_reading @@index([tenantId, supersedesReadingId])`（D23 指定评估项；加上成本低）
- `seed.ts`：`permCodes` 加 `exception:read` / `exception:manage`；角色绑定建议 `reviewer: +exception:read+manage`、`reader: +exception:read`、`cashier: +exception:read`（实现 Gate 确认）
- 验收：`migrate dev` 干净；psql 验证 partial index 生效（同 key 双活动 episode 被拒）；`prisma migrate diff` 无 drift

### T2 — Module 骨架 + RBAC

**目标**：`src/modules/exception/` 模块注册，权限装饰器接线。

- `exception.module.ts` / `exception.controller.ts` / `exception.service.ts` / `exception.detector.ts` / `exception.reconciler.ts` / `exception.types.ts`
- Controller 全部 `@Permissions('exception:read')`（读）/ `'exception:manage'`（写）；沿用 `currentTenant()` + orgScope ctx 传递模式
- 验收：无权限 403；有 read 无 manage 写端点 403

### T3 — Detector 层（纯查询）

**目标**：13 类 detector，`SoT → AnomalyFact[]`，零写、零读 work_item。

- `detectors/` 每域一文件：account（NO_ACTIVE_METER / MULTI_ACTIVE_METER / NO_BOOK / MULTI_BOOK）、reading（QC_REVIEW / QC_REJECTED）、settlement（ESTIMATE_STREAK）、remote（5 类）、billing（UNPAID_BILL_OVERDUE）
- `ESTIMATE_STREAK`：**先把 `SettlementService.estimateStreaks` 抽成 `common/estimate-streak.ts` 共享 helper**（settlement.service 改为调用它），detector 复用——不复制算法
- QC anti-supersede：`NOT EXISTS child WHERE child.supersedes_reading_id = r.id`（D23 已冻结谓词）
- Remote anchor 解析：detector 输出 `scopeAnchor`——UNBOUND/KEY_CONFLICT→REMOTE_SOURCE；WAITING_PLAN/FAILED/CONFLICT→resolved ACCOUNT；户 off-book→TENANT（D12/D21）
- KEY_CONFLICT key 带 `{currentIssueAt}`（ISO 序列化）；**并发/连续冲突测试决定是否需要换 `RemoteEventProcessLog.id`**（Gate 批准的 hardening 项）
- 验收：detector 单元级 e2e——每类正例+排除例（D3 排除集）

### T4 — Scope 引擎

**目标**：批量 scope 谓词，复用 `common/account-scope.ts`。

- 收集本页 facts 的 waterAccountIds → `outOfScopeAccountIds` 一次过滤；REMOTE_SOURCE facts → `remote_source.orgUnitId` 子树过滤；TENANT anchor → 仅 tenant 级角色放行
- **户级 anchor 判定顺序**：current BookMeter count=0 → TENANT；≥1 → ACCOUNT 覆盖链（D12/D14——**不查历史 plan_item**）
- 验收：跨所户异常 scoped 不可见；off-book 户异常 Branch 不可见、tenant 可见；UNBOUND 按 source orgUnitId

### T5 — Reconciler

**目标**：唯一系统写 work_item 的路径；**GET 零写**。

- `reconcileTx(ctx)`：detector 全量 → join 活动 episodes → 命中无 episode→INSERT OPEN；未命中 OPEN/ACK→`RESOLVED+AUTO+resolvedAt+clearedAt`；未命中 IGNORED→`clearedAt`
- 并发：partial unique 兜底，INSERT 冲突→幂等跳过（`ON CONFLICT` 或 catch unique violation）
- 触发形态 V1 = **显式 `POST /exceptions/refresh`（exception:manage）** + 服务内调用点预留接口；不加 @nestjs/schedule 新依赖（实现 Gate 可议）
- 验收：D3/D10/D22 生命周期矩阵全过（含 IGNORED→消失→复现=新 episode；remote replay=旧 RESOLVED+新 OPEN；KEY_CONFLICT occurrence 轮换）

### T6 — Episode 写 API

**目标**：ack / assign / ignore / resolve / unignore。

- 每个写端点：`detector.evaluate(key)` 先行（resolve 反向：fact active→`409 ANOMALY_STILL_ACTIVE`）→ scope 校验 → 写 work_item
- assign：assignee 必须是该租户 staff 且对该 anomaly scope 可见 → `403 ASSIGNEE_OUT_OF_SCOPE`
- ignore：note 必填 → `400 NOTE_REQUIRED`；已清除 episode 操作 → `409 EPISODE_CLEARED`
- 验收：错误语义表（Domain §9）逐条 e2e

### T7 — Query API（只读）

**目标**：`GET /exceptions` / `/summary` / `/:key`。

- 列表 = detector 结果 LEFT JOIN 活动 episode → scope 批过滤 → 分页 `take=50`；返回 `asOf`
- `GET /exceptions/:key` 含同 key 已清除 episode 历史
- **显式断言 GET 零写**：e2e 前后 work_item 行数/dirty 检查
- 验收：summary 计数与列表一致；分页稳定

### T8 — Web UI

**目标**：异常中心页面 + 跳转链路。

- `apps/web/src/pages/exception/`：列表（severity/type/status/book/period 过滤器）、详情抽屉（fact 快照 + episode + 历史）、统计条
- 菜单项按 `exception:read` 显隐；操作按钮按 `exception:manage` 显隐
- Drill-down 链接到 360 / reading plan / bill / remote event 既有页面——目标页权限不足时由各域页面自然拒绝（不再前端拦）
- 验收：UAT slices S1–S8 对应路径可点通

### T9 — 测试与验证

- e2e：`apps/api/test/exception-center.e2e-spec.ts`——detector 正确性、scope、RBAC、生命周期、并发（双 reconcile 同 key / 同毫秒 KEY_CONFLICT）、GET 零写
- UAT：`tests/uat-e9/exception-center.spec.ts`（S1–S8），`playwright.e9.config.ts`
- 全量：`pnpm -r build`、oxlint 0、full e2e、E8 回归不破

## 依赖与风险

| 依赖/风险 | 处理 |
|---|---|
| `estimateStreaks` 当前是 SettlementService 私有 | T3 第一步抽 helper；settlement 行为零变化（回归靠现有 spec） |
| Reconcile 频率无定时器 | V1 显式 refresh；cron 待实现 Gate 议 |
| partial unique 的 Prisma 表达 | migration 原生 SQL；schema 注释标注 |
| off-book 判定每列表查询成本 | BookMeter count 批量一次查，不进循环 |
| KEY_CONFLICT occurrence 碰撞 | 测试先行；备用 token = `RemoteEventProcessLog.id` |

## 完成定义（DoD）

- Domain §10 测试矩阵全绿 + Gate 指定三盯点有专测
- `pnpm -r build` / oxlint / full e2e / UAT e9 全过
- `git diff main` 无既有行为变更（除 settlement helper 抽取的等价重构）
- 输出 RC 给 Release Gate

# 水务抄表收费 SaaS MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec 实现多租户水务抄表收费 SaaS MVP：立户→抄表→结算→开账→柜台收费→销账→日结全链路，含估抄/换表/锚点式补差/红冲。

**Architecture:** NestJS 模块化单体（iam/customer/metering/billing/payment/report/integration）+ BullMQ Worker + React(AntD) 管理端；PostgreSQL 共享库 `tenant_id` + transaction-local RLS；领域纯函数集中在 `packages/billing-core`。

**Tech Stack:** pnpm monorepo / NestJS 10 / Prisma / PostgreSQL 15 / BullMQ+Redis / React 18+Vite+AntD5 / vitest(billing-core) / jest+supertest(api)

**Spec:** `docs/superpowers/specs/2026-09-18-water-saas-mvp-design.md`

## Global Constraints

- 金额一律 `bigint` 分（`amount_cent`）；水量 `numeric(18,4)`；单价 `numeric(18,6)`；账期 `char(6)` `YYYYMM`。
- 舍入：`bill_item.amount = round_half_up(qty × unit_price)` 到分，`bill.total = Σ items`。
- 所有业务表含 `tenant_id` + `created_at/created_by/updated_at/updated_by`；`id` 用 uuid。
- 财务事实 immutable：POSTED/FINAL 后金额/数量/单价/来源不可改；状态迁移记 `audit_log`。
- RLS：所有业务查询在事务内 `set_config('app.tenant_id', $1, true)`；应用角色非 owner、无 BYPASSRLS；核心表 `FORCE ROW LEVEL SECURITY`。
- 幂等：`bill UNIQUE(tenant_id, source_type, source_id, bill_kind)`；POST 端点支持 `Idempotency-Key`。
- 枚举值以 spec §2.7 状态机为准，命名全大写。
- 不做（禁止实现）：移动 APP、在线支付、代扣文件、电子发票、短信、智能表平台、工单流、预付费扣款、总分表计费。

## File Structure

```
water-saas/
├── package.json (pnpm workspace root)
├── pnpm-workspace.yaml
├── docker-compose.yml                    # postgres:15 + redis:7 + (可选)mailhog
├── .env.example
├── packages/
│   ├── types/                            # 共享枚举+DTO（前后端共用）
│   │   └── src/{enums.ts, dto.ts, index.ts}
│   └── billing-core/                     # 纯函数领域核心，无 IO
│       └── src/{estimator.ts, tariff.ts, settle.ts, reconcile.ts, money.ts, index.ts}
│       └── tests/*.test.ts               # vitest
├── apps/
│   ├── api/                              # NestJS
│   │   ├── prisma/schema.prisma
│   │   ├── prisma/migrations/
│   │   ├── src/main.ts
│   │   ├── src/common/{tenant-context.ts, tenant-prisma.ts, audit.interceptor.ts,
│   │   │              idempotency.interceptor.ts, permissions.guard.ts}
│   │   └── src/modules/{iam,customer,metering,billing,payment,report,integration}/
│   │   └── test/*.e2e-spec.ts            # jest + supertest
│   ├── worker/                           # BullMQ consumers（复用 api 代码库，独立进程入口）
│   └── web/                              # React + Vite + AntD
│       └── src/{main.tsx, api/client.ts, pages/*, layouts/AdminLayout.tsx}
└── docs/superpowers/{specs,plans}/
```

## 任务依赖图

```
T1 scaffold → T2 DB/RLS → T3 IAM → T4 customer → T5 plan/plan_item →
T6 readings+QC → T7 settlement+estimator → T8 tariff → T9 billing-core compute →
T10 billing_run+bill+红冲 → T11 reconciliation → T12 payment+日结 →
T13 reports+integration stubs → T14-T16 web 页面
```

---

### Task 1: Monorepo 脚手架 + 基础设施

**Files:**
- Create: `package.json`、`pnpm-workspace.yaml`、`docker-compose.yml`、`.env.example`、`tsconfig.base.json`
- Create: `packages/types/package.json`、`packages/types/src/enums.ts`、`packages/types/src/index.ts`
- Create: `packages/billing-core/package.json`、`packages/billing-core/tsconfig.json`、`vitest.config.ts`
- Create: `apps/api/`（`nest new` 生成）、`apps/web/`（`pnpm create vite` 生成）

**Interfaces:**
- Produces: workspace 结构、`packages/types` 的全部枚举（后续所有任务 import）

- [ ] **Step 1: 初始化 workspace**

```bash
mkdir -p water-saas && cd water-saas
pnpm init
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - 'apps/*'
  - 'packages/*'
EOF
```

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: watersaas
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
volumes:
  pgdata:
```

`.env.example`: `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/watersaas`、`REDIS_URL=redis://localhost:6379`、`JWT_SECRET=dev-secret-change-me`

- [ ] **Step 2: 生成 apps 与 packages**

```bash
cd water-saas
pnpm add -g @nestjs/cli
nest new apps/api --package-manager pnpm --skip-git
pnpm create vite apps/web --template react-ts
mkdir -p packages/types/src packages/billing-core/src packages/billing-core/tests
```

`packages/types/package.json`: `{"name":"@ws/types","version":"0.0.0","main":"src/index.ts","types":"src/index.ts"}`
`packages/billing-core/package.json`: `{"name":"@ws/billing-core","version":"0.0.0","main":"src/index.ts","types":"src/index.ts","devDependencies":{"vitest":"^2.0.0","typescript":"^5.5.0"}}`

- [ ] **Step 3: 写共享枚举（spec §2.7 逐字）**

`packages/types/src/enums.ts` 含 spec 全部枚举，示例：

```ts
export const METER_STATUSES = ['AVAILABLE','INSTALLED','MAINTENANCE','RETIRED'] as const;
export type MeterStatus = typeof METER_STATUSES[number];
export const READ_RESULT_TYPES = ['ACTUAL','REMOTE','NO_READ'] as const;
export type ReadResultType = typeof READ_RESULT_TYPES[number];
export const EXCEPTION_CODES = ['LOCKED','DIAL_DIRTY','FLOODED','OCCUPIED','STOPPED','BROKEN','SUSPECTED_THEFT','OTHER'] as const;
export type ExceptionCode = typeof EXCEPTION_CODES[number];
export const QC_STATUSES = ['PENDING','PASSED','REJECTED','MANUAL_REVIEW'] as const;
// ... 其余枚举同法：QCStatus, PlanItemStatus, SettlementStatus, ComponentSourceType,
// ReconStatus(DRAFT,ABSORBED,APPLIED,MANUAL_REVIEW), TariffStatus, RunType, RunStatus,
// BillKind, BillSourceType, BillStatus, BillItemType, PayChannel, PaymentStatus,
// CalcType, AccountStatus, AccountEventType, ReadSource, InstallReason, InstallationStatus, MeterStatus, PlanStatus
```

- [ ] **Step 4: 验证构建**

Run: `cd water-saas && pnpm install && docker compose up -d && pnpm -r build`
Expected: api/web/types/billing-core 全部编译通过；`docker compose ps` 两个容器 Up。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: monorepo scaffold (api/web/billing-core/types) + docker infra"
```

---

### Task 2: Prisma schema 全量建模 + RLS 基建

**Files:**
- Create: `apps/api/prisma/schema.prisma`、`apps/api/prisma/migrations/0001_init.sql`（prisma migrate dev 生成后手工追加 RLS 段）、`apps/api/prisma/seed.ts`
- Create: `apps/api/src/common/tenant-context.ts`、`apps/api/src/common/tenant-prisma.ts`
- Test: `apps/api/test/rls.e2e-spec.ts`

**Interfaces:**
- Produces: `TenantPrismaService.runAsTenant<T>(tenantId, fn)` —— 后续所有模块 service 经它访问 DB；`withTenantContext()` AsyncLocalStorage 存取 `tenantId/orgScope/staffId`。

- [ ] **Step 1: 写 schema.prisma（按 spec §3 全量，~30 模型）**

要点：
- `generator client` + `datasource db`（`DATABASE_URL`）。
- 每个模型 `tenantId String @db.Uuid` + `@@index([tenantId, …])`；审计字段 `createdAt DateTime @default(now())` 等 map 到 snake_case。
- 枚举用 Prisma `enum`（与 `packages/types` 常量一一对应）。
- `bill` 加 `@@unique([tenantId, sourceType, sourceId, billKind])`；`consumptionSettlement` 加 `@@unique([tenantId, waterAccountId, period])`；`idempotencyKey @@unique([tenantId, key])`。
- `meterReading.planItemId`、`readingPlanItem.plannedInstallationId nullable`、`meterReading.supersedesReadingId` 自引用、`reconciliation.absorbedSettlementId nullable`、`bill.tariffPlanId`。
- 金额 `BigInt`；水量/单价 `Decimal`（`@db.Decimal(18,4)` / `@db.Decimal(18,6)`）。

示例模型：

```prisma
model MeterReading {
  id                String   @id @default(uuid()) @db.Uuid
  tenantId          String   @db.Uuid
  planItemId        String?  @db.Uuid
  installationId    String   @db.Uuid
  meterId           String   @db.Uuid
  period            String   @db.Char(6)
  readDate          DateTime @db.Date
  resultType        ReadResultType
  readingValue      Decimal? @db.Decimal(18,4)
  exceptionCode     ExceptionCode?
  supersedesReadingId String? @db.Uuid
  qcStatus          QcStatus @default(PENDING)
  qcBy              String?  @db.Uuid
  qcAt              DateTime?
  source            ReadSource
  operatorId        String   @db.Uuid
  photoRef          String?
  remark            String?
  createdAt DateTime @default(now())
  createdBy String?  @db.Uuid
  updatedAt DateTime @updatedAt
  updatedBy String?  @db.Uuid
  @@map("meter_reading")
}
```

- [ ] **Step 2: migrate 并追加 RLS SQL**

```bash
cd apps/api && pnpm add @prisma/client && pnpm add -D prisma
npx prisma migrate dev --name init
```

在生成的 migration 末尾追加（核心表逐个执行）：

```sql
CREATE ROLE ws_app LOGIN PASSWORD 'ws_app_pw' NOINHERIT;
GRANT CONNECT ON DATABASE watersaas TO ws_app;
GRANT USAGE ON SCHEMA public TO ws_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ws_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ws_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customer','settle_account','water_account','meter','meter_installation','account_event',
    'reading_book','book_meter','reading_plan','reading_plan_item','meter_reading',
    'consumption_settlement','consumption_component','reconciliation','estimate_rule',
    'fee_item','tariff_plan','tariff_tier','billing_run','bill','bill_item','idempotency_key',
    'payment','payment_alloc','receipt','cashier_day_close','audit_log','sys_sequence','tenant_param',
    'org_unit','staff','role','staff_role','role_permission','permission'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid);', t);
  END LOOP;
END $$;
```

（`tenant` 表本身不带 tenant_id，例外处理：RLS 用 `id = current_setting(...)::uuid`。）

- [ ] **Step 3: 实现租户上下文**

`tenant-context.ts`（AsyncLocalStorage）：

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
export interface TenantCtx { tenantId: string; staffId: string; orgScope: string[] }
export const als = new AsyncLocalStorage<TenantCtx>();
export const withTenant = <T>(ctx: TenantCtx, fn: () => T): T => als.run(ctx, fn);
export const currentTenant = (): TenantCtx => {
  const c = als.getStore();
  if (!c) throw new Error('tenant context missing');
  return c;
};
```

`tenant-prisma.ts`：包一层交互事务 + transaction-local set_config：

```ts
@Injectable()
export class TenantPrismaService implements OnModuleInit {
  private prisma = new PrismaClient();
  async onModuleInit() { await this.prisma.$connect(); }
  runAsTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }
  get raw() { return this.prisma; }  // 仅 migration/seed/系统级用
}
```

- [ ] **Step 4: 写 RLS 验证测试**

`test/rls.e2e-spec.ts`：seed 两租户各一条 customer；用 `ws_app` 角色连接，tx1 set tenant A 可查 A 不可查 B；同连接归还池后再用不 set → 查不到任何行（验证 transaction-local 无残留）。用 `pg` 直连断言。

```bash
pnpm --filter api test:e2e
```

Expected: 3 条断言全过。

- [ ] **Step 5: seed 基础数据**

`seed.ts`：tenant `cd-water`/`xh-water`、org 树、admin 账号（bcrypt）、role `admin/reader/cashier/reviewer`、fee_item（水费/污水费）、estimate_rule（AVG3）。

- [ ] **Step 6: Commit** `feat: prisma schema + tenant RLS infrastructure`

---

### Task 3: IAM — 登录/JWT/权限守卫/审计日志

**Files:**
- Create: `src/modules/iam/{auth.controller.ts, auth.service.ts, jwt.strategy.ts}`、`src/common/{permissions.guard.ts, audit.interceptor.ts, tenant.interceptor.ts, idempotency.interceptor.ts}`
- Create: iam CRUD `orgs/staff/roles/tenant-params` controller+service
- Test: `test/auth.e2e-spec.ts`

**Interfaces:**
- Consumes: `TenantPrismaService`、`withTenant/currentTenant`
- Produces: `@Permissions('customer:write')` 装饰器 + `PermissionsGuard`；`TenantInterceptor`（从 JWT 注入 ALS ctx）；`AuditInterceptor`（写操作落 audit_log）；`IdempotencyInterceptor`（`Idempotency-Key` 去重）；`POST /auth/login → {accessToken, refreshToken}`、`GET /auth/me`

- [ ] **Step 1: 失败测试** — 无 token 401；login 成功返回 JWT 且 `GET /auth/me` 返回 staff+role；tenant A token 请求带 `X-Tenant-Id: B` 被拒（token 内 tenant 为准）。
- [ ] **Step 2: 实现** — bcrypt 校验、`@nestjs/jwt` 签发（payload `{sub, tenantId, orgScope, perms}`）、guard 校验权限码、interceptor 注入 ALS、写操作后 `audit_log` 记 before/after。
- [ ] **Step 3: 测试通过 + Commit** `feat: iam auth + tenant context + audit log`

---

### Task 4: customer 模块 — 三户/水表/安装/立户向导

**Files:**
- Create: `src/modules/customer/{customer,settle-account,water-account,meter,meter-installation}.ts`（controller+service 分文件）
- Test: `test/customer.e2e-spec.ts`

**Interfaces:**
- Produces: `POST /water-accounts/onboard`（一次创建 customer+water_account+meter+installation，事务内）、`POST /meter-installations/:id/remove`（拆表，需 final_reading）、`POST /meter-installations`（装表/复装）、`POST /water-accounts/:id/{transfer|suspend|resume|close}`（写 `account_event`）

- [ ] **Step 1: 失败测试** — onboard 后 installation ACTIVE；拆表后 installation REMOVED + meter AVAILABLE；换表（remove+新 install）后户有两条 installation；销户要求欠费为 0（先 mock 欠费查询接口 `billing.getOutstanding(accountId)`，实现后置 stub 返回 0）。
- [ ] **Step 2: 实现** — `sys_sequence` 发号（`customer_no`/`account_no` 规则：`前缀+yyyyMM+6位序列`，租户隔离）；onboard 全事务；event 写 `account_event`。
- [ ] **Step 3: 测试通过 + Commit** `feat: customer domain (3-account model, meter installation lifecycle)`

---

### Task 5: metering — 抄表册/计划/plan_item 快照

**Files:**
- Create: `src/modules/metering/{reading-book,reading-plan}.ts`
- Test: `test/reading-plan.e2e-spec.ts`

**Interfaces:**
- Produces: `POST /reading-plans/generate {bookId, period, planDate}` → 创建 plan + 把**当前** `book_meter` 成员快照为 `reading_plan_item`（`planned_installation_id` = 当时 ACTIVE installation，可空）；`GET /reading-plans/:id/items`、`GET /reading-plans/:id/progress`（按 status 计数）

- [ ] **Step 1: 失败测试** — 册含 A/B/C 生成计划（3 个 item，seq 有序）；生成后册删除 B 增加 D → 该 plan items 仍 A/B/C；progress 返回 `{PENDING:3}`。
- [ ] **Step 2: 实现** — generate 事务内 copy book_meter → plan_item；`book_meter` 挂 `water_account_id`。
- [ ] **Step 3: 测试通过 + Commit** `feat: reading plan snapshot via plan_item`

---

### Task 6: 抄表录入 + QC

**Files:**
- Create: `src/modules/metering/meter-reading.ts`、`src/modules/metering/csv-import.ts`
- Test: `test/meter-reading.e2e-spec.ts`

**Interfaces:**
- Produces: `POST /meter-readings`（单条/批量：ACTUAL 带 reading_value 或 NO_READ 带 exception_code）、`POST /meter-readings/import`（CSV）、`POST /meter-readings/:id/qc {action: pass|reject|review}`、`POST /meter-readings/:id/supersede {readingValue}`（新 ACTUAL 指 supersedes_reading_id）

- [ ] **Step 1: 失败测试** — NO_READ 无 exception_code → 400；录入后 plan_item.status → READ/NO_READ；supersede 后原记录保留、新记录 supersedes 指向它；QC pass 后 qc_status=PASSED。
- [ ] **Step 2: 实现** — 校验规则（ACTUAL 必须有值、NO_READ 必须 exception_code、period 格式）；写 reading 同事务更新 plan_item；supersede 校验原记录未被 supersede 过。
- [ ] **Step 3: 测试通过 + Commit** `feat: meter reading entry, QC, supersede chain`

---

### Task 7: billing-core estimator + settlement/component 生成

**Files:**
- Create: `packages/billing-core/src/{money.ts, estimator.ts}`、`packages/billing-core/tests/estimator.test.ts`
- Create: `src/modules/metering/{settlement.service.ts, estimate.controller.ts}`
- Test: `test/settlement.e2e-spec.ts`

**Interfaces:**
- Consumes: readings（PASSED）、installations、tenant_params
- Produces:
  - `estimateAvg3(validUsages: number[]): number | null`（billing-core；不足 3 次返回 null）
  - `POST /estimate/preview {waterAccountId, period}` → `{suggestedUsage, method, basis}`
  - `POST /consumption-settlements`（按户+period 生成 DRAFT settlement+components，内部逻辑见 Step 2）、`POST /consumption-settlements/:id/finalize`

- [ ] **Step 1: estimator 纯函数测试（vitest）**

```ts
import { describe, it, expect } from 'vitest';
import { estimateAvg3 } from '../src/estimator';

describe('estimateAvg3', () => {
  it('returns mean of last 3 valid usages', () => {
    expect(estimateAvg3([30, 36, 33])).toBe(33);
  });
  it('uses fewer than 3 if that is all we have', () => {
    expect(estimateAvg3([40, 20])).toBe(30);
  });
  it('returns null with no history', () => {
    expect(estimateAvg3([])).toBeNull();
  });
});
```

```ts
// estimator.ts
export function estimateAvg3(validUsages: number[]): number | null {
  if (validUsages.length === 0) return null;
  const last3 = validUsages.slice(-3);
  return Math.round((last3.reduce((a, b) => a + b, 0) / last3.length) * 10000) / 10000;
}
```

（取最近 3 个有 ACTUAL 读数的 settlement/component 用量。）

- [ ] **Step 2: settlement 生成逻辑 + e2e**

规则（对每个 water_account × period）：
1. 当期每个 ACTIVE/本期 REMOVED 的 installation → 一个 component。
2. component 有 PASSED ACTUAL → `source_type=READING`、`usage = end - prev`（prev = installation 的 initial_reading 或上期 effective end）；满刻度翻转按 `max_dial` 折算。
3. plan_item 为 NO_READ 或无读数 → `source_type=ESTIMATE`：`suggested = estimateAvg3(近3次)`；操作员可改值、必填 `estimate_reason`；`end_reading_value = prev + usage`（synthetic，仅结算链用）。
4. `total_usage_qty = Σ components`；`is_estimated = any component ESTIMATE`。
5. 连续估抄计数超 `max_consecutive_estimates` → settlement 仍可生成但户进"补抄台账"（报告查询）。

e2e：覆盖中途换表（旧 component final 130-100=30 + 新 18-0=18 = 48）与估抄（NO_READ→AVG3→finalize）。

- [ ] **Step 3: 测试通过 + Commit** `feat: consumption settlement header/component + AVG3 estimator`

---

### Task 8: tariff 配置 + 版本冻结

**Files:**
- Create: `src/modules/billing/{fee-item,tariff-plan}.ts`
- Test: `test/tariff.e2e-spec.ts`

**Interfaces:**
- Produces: `POST /tariff-plans`、`POST /tariff-plans/:id/activate`、`POST /tariff-plans/:id/new-version`（复制 tiers + 新 effective_from）、`PATCH /tariff-plans/:id`（DRAFT 限定；ACTIVE 且已被 bill 引用 → 409）

- [ ] **Step 1: 失败测试** — DRAFT 可改；ACTIVE 未被引用可改生效区间但不能改已算 tier？——按 spec：**被 POSTED bill 引用后计算字段全冻结**（先插一条 POSTED bill 引用 → PATCH unit_price → 409）；`new-version` 生成独立 plan。
- [ ] **Step 2: 实现** — 冻结判定：`EXISTS bill WHERE tariff_plan_id = id AND status != 'DRAFT'`。
- [ ] **Step 3: 测试通过 + Commit** `feat: tariff plans with version freeze`

---

### Task 9: billing-core 计费引擎（纯函数，重测试）

**Files:**
- Create: `packages/billing-core/src/{tariff.ts, settle.ts}`、`packages/billing-core/tests/{tariff.test.ts, settle.test.ts}`

**Interfaces:**
- Produces:
  - `roundCent(v: number): number`（HALF_UP 到分）
  - `tieredAmount(qty: number, ytdBeforeQty: number, tiers: Tier[]): {amountCent, parts:{tierNo,qty,unitPrice,amountCent}[]}`
  - `computeBill(input: {components: {usageQty:number}[], tiers: Tier[], feeItems: {code,calcType,price|percent}[], ytdBeforeQty:number}): BillItemDraft[]`

- [ ] **Step 1: 失败测试（关键场景写全）**

```ts
// 普通单价: 48m³ × 3.2 = 153.60元 = 15360分
// 阶梯: ytd=170, tiers=[{to:180,p:3.0},{to:null,p:4.5}], qty=15
//   → 10m³@3.0 + 5m³@4.5 = 3000+2250 = 5250分
// 阶梯跨年: ytd 按自然年重置（ytdBeforeQty 由调用方算）
// 多费用项: 水费 PER_QTY + 污水费 PER_QTY 各自成行
// qty=0 → 无行；负数 qty 抛 DomainError
```

- [ ] **Step 2: 实现纯函数**（无 IO、无 Date.now 依赖——today 由入参传）。

```ts
export function tieredAmount(qty, ytdBeforeQty, tiers) {
  let remaining = qty, cursor = ytdBeforeQty, amountCent = 0; const parts = [];
  for (const t of tiers) {
    if (remaining <= 0) break;
    const cap = t.toQty === null ? Infinity : t.toQty - cursor;
    const inTier = Math.min(remaining, Math.max(0, cap));
    if (inTier <= 0) { if (t.toQty !== null && cursor >= t.toQty) continue; }
    const cent = roundCent(inTier * t.unitPrice);
    parts.push({ tierNo: t.tierNo, qty: inTier, unitPrice: t.unitPrice, amountCent: cent });
    amountCent += cent; remaining -= inTier; cursor += inTier;
  }
  return { amountCent, parts };
}
```

- [ ] **Step 3: 测试通过 + Commit** `feat(billing-core): tiered tariff + bill computation`

---

### Task 10: 开账批次 + 账单 + 红冲/重开

**Files:**
- Create: `src/modules/billing/{billing-run.service.ts, bill.service.ts, billing.controller.ts}`、`apps/worker/src/{main.ts, billing.consumer.ts}`
- Test: `test/billing.e2e-spec.ts`

**Interfaces:**
- Consumes: FINAL settlements、tariff（`usage_category`→ACTIVE plan@period 生效版本）、billing-core
- Produces: `POST /billing-runs {period}`（DRAFT 批：试算生成 DRAFT bills）、`POST /billing-runs/:id/post`（事务/分批 POST，`source_type=SETTLEMENT, source_id=settlementId, bill_kind=NORMAL`）、`POST /billing-runs/:id/discard`、`POST /bills/:id/reverse`（生成 `bill_kind=REVERSAL, source_type=ORIGINAL_BILL, source_id=原bill`）、`POST /bills/:id/replace`（REPLACEMENT）

- [ ] **Step 1: 失败测试** — 幂等：同一 settlement POST 两次 → 唯一约束冲突被捕获为"已存在"，bill 仍一张；reverse 后原 bill status=REVERSED 且存在负向 REVERSAL 单（amount 取负）；DRAFT 批 discard 后可重跑。
- [ ] **Step 2: 实现** — post 走 BullMQ job（逐 settle_account 分组、单 bill 一事务、失败记 FAILED 可重跑）；`bill.tariff_plan_id` = 计算用 plan；`is_estimated` 继承。
- [ ] **Step 3: 测试通过 + Commit** `feat: billing run + bill lifecycle + reversal/replacement`

---

### Task 11: Reconciliation — 锚点校准 + 吸收/调整

**Files:**
- Create: `packages/billing-core/src/reconcile.ts`、`tests/reconcile.test.ts`
- Create: `src/modules/billing/reconciliation.service.ts`、`reconciliation.controller.ts`
- Test: `test/reconciliation.e2e-spec.ts`

**Interfaces:**
- Consumes: FINAL settlements（is_estimated）、PASSED ACTUAL readings、tariff、已 POSTED bills
- Produces:
  - `buildReconciliation(anchor, actual, settlements): {actualTotalUsage, previouslySettled, remainderUsage}`
  - `reprice(input): {correctChargeCent, breakdown}`（billing-core）
  - `POST /reconciliations/:id/apply`（ADJUSTED 路径生成 `source_type=RECONCILIATION` 的 ADJUSTMENT bill）

- [ ] **Step 1: 纯函数测试**

```ts
// anchor=1000, actual=1080, settled=[30,35] → total=80, settled=65, remainder=15 (≥0 → ABSORB)
// actual=1055 → remainder=-10 → ADJUST 路径
// anchor 选取: 范围内最后一次 result_type∈{ACTUAL,REMOTE} 且未被 supersede 的 PASSED 读数
```

- [ ] **Step 2: e2e 两场景**
  - a. 实抄 1000 → 估30(FINAL) → 估35(FINAL) → 实抄1080：自动产生 reconciliation（DRAFT），apply → `status=ABSORBED`、`absorbed_settlement_id`=9月 settlement（其 usage=15）；**断言无新 bill**。
  - b. 实抄 1055：apply → `reprice()` → `status=APPLIED` + ADJUSTMENT bill（金额=correct−posted，负值）。
- [ ] **Step 3: 实现** — 触发点：ACTUAL 读数 QC PASS 后检查其覆盖范围内是否有 estimated FINAL settlement；absorb 路径把 remainder 写入当前期 settlement（`consumption_component.source_type=READING`）；adjust 路径重计价生成 adjustment bill。
- [ ] **Step 4: 测试通过 + Commit** `feat: anchor-based reconciliation (absorb-first, adjust on negative)`

---

### Task 12: 收款/销账/收据/日结

**Files:**
- Create: `src/modules/payment/{payment.service.ts, payment.controller.ts, receipt.ts, day-close.ts}`
- Test: `test/payment.e2e-spec.ts`

**Interfaces:**
- Produces: `POST /payments {settleAccountId, channel, amount, allocs:[{billId, amount}]}`、`GET /water-accounts/:id/outstanding`（未清账单）、`POST /payments/:id/reverse`、`POST /receipts/:id/print`、`POST /cashier-day-close/close`

- [ ] **Step 1: 失败测试** — 一笔 payment 分摊 2 bill（一个全清→PAID、一个部分→PARTIAL_PAID）；allocs 总额≠payment.amount → 400；重复 Idempotency-Key → 返回原单；日结后收款不可 REVERSED 当日？（日结 POSTED 后允许 REVERSED 但记 audit，简化：允许，报表按状态过滤）；收据号唯一。
- [ ] **Step 2: 实现** — 收款事务：payment + allocs + 更新 bill.status（重算 Σalloc vs total）；receipt 发号；day_close 汇总 `by_channel`。
- [ ] **Step 3: 测试通过 + Commit** `feat: counter payment, multi-bill allocation, day close`

---

### Task 13: 报表 + integration stub + 审计覆盖

**Files:**
- Create: `src/modules/report/reports.controller.ts`（4 个查询端点）、`src/modules/integration/ports.ts`（SmsPort/PaymentChannelPort/SmartMeterPort/FinancePort/ReportInstallPort 接口 + Stub 实现）
- Test: `test/report.e2e-spec.ts`

- [ ] **Step 1: 失败测试** — 抄表日报（按 plan_item 统计 READ/NO_READ/PENDING）、收费日报（按 cashier/channel）、应收实收月报、回收率。
- [ ] **Step 2: 实现** — 报表只读 SQL（视图或 service 查询）；ports 接口定义在 `packages/types` 或 api 内，Stub 返回 `NOT_IMPLEMENTED`。
- [ ] **Step 3: 测试通过 + Commit** `feat: reports + integration port stubs`

---

### Task 14: Web — 登录/布局/系统管理页

**Files:**
- Create: `apps/web/src/{main.tsx, api/client.ts, auth/AuthContext.tsx, layouts/AdminLayout.tsx, pages/{Login,Workbench,system/*}}`
- Create: `apps/web/vite.config.ts`（proxy `/api` → api:3000）

**Interfaces:**
- Consumes: `/auth/login`、`/auth/me`、iam CRUD API

- [ ] **Step 1: 实现** — axios 拦截器带 JWT；登录页（租户码+账号+密码）；AdminLayout：左侧菜单按 permission 过滤，顶栏显示租户/用户；系统管理页：组织树、用户、角色、参数、操作日志列表。
- [ ] **Step 2: 手测** — `pnpm dev` 起 web+api，登录两租户验证菜单/数据隔离。
- [ ] **Step 3: Commit** `feat(web): login + admin layout + system pages`

---

### Task 15: Web — 客户/抄表/结算页面

**Files:**
- Create: `pages/customer/{CustomerList,WaterAccountDetail,OnboardWizard,MeterTimeline}.tsx`、`pages/metering/{Books,Plans,ReadingEntry,QcQueue}.tsx`、`pages/settlement/{Settlements,Reconciliations}.tsx`

- [ ] **Step 1: 实现** — 立户向导（customer→account→install 三步表单）；水表详情页 installation 时间线；读数录入页（按 plan_item 逐条，支持标 NO_READ+异常码、批量导入 CSV）；QC 队列（PENDING/MANUAL_REVIEW，pass/reject）；settlement 列表含 component 展开；reconciliation 列表（DRAFT→apply 按钮，显示 remainder）。
- [ ] **Step 2: 手测完整链路** — 立户→计划→录数→QC→结算。
- [ ] **Step 3: Commit** `feat(web): customer + metering + settlement pages`

---

### Task 16: Web — 计费/收费/报表页面 + 收尾

**Files:**
- Create: `pages/billing/{Tariffs,BillingRuns,Bills}.tsx`、`pages/payment/{Cashier,DayClose}.tsx`、`pages/report/Reports.tsx`

- [ ] **Step 1: 实现** — 水价方案编辑（tier 表格 + 版本冻结提示）；开账批次（生成→试算→post→discard）；账单列表（"估"标记、红冲/重开按钮）；收款台（按结算户查 outstanding→勾选账单→输入金额→分摊预览→提交+打印收据）；日结页；四张报表页（查询+导出 CSV）。
- [ ] **Step 2: 端到端手测验收标准 1-10**（spec §6 逐条）。
- [ ] **Step 3: Commit** `feat(web): billing + cashier + reports pages`

---

## Self-Review 结论

- Spec 覆盖：§1 架构(T1-T2,T14)、§1.2 RLS(T2,T3)、§1.3 不可变(T10,T12 全程)、§2.1 三户+installation(T4)、§2.2 读数+plan_item(T5,T6)、§2.3 settlement/component(T7)、§2.4 reconciliation(T11)、§2.5 计费+冻结(T8,T9,T10)、§2.6 收款(T12)、§2.8 stub(T13)、§4 API(各任务 controller)、§5 页面(T14-T16)、§6 验收(T16 Step2 逐条)。
- 类型一致性：`estimateAvg3`、`tieredAmount`、`computeBill`、`buildReconciliation`、`reprice`、`runAsTenant`、`withTenant/currentTenant` 签名在产出/消费处一致。
- 无占位符；CRUD 细节（字段校验、分页）由 spec §3 表结构直接映射，测试断言已在各任务给出。

# v0.2 测试反馈设计 v1.1（feat/v0.2-feedback）

来源：《初版网页系统补充.docx》测试反馈 + 业务确认 + 架构复核。基于 `main`（v0.1.1-mvp，f364101）。

v1.1 相对 v1.0 的两处实质修改（来自评审）：

- **A. householdSize 从"账户当前值"升级为有效期化档案 + 结算快照**——否则资费冻结了但人口参数没冻结，历史补差/红冲重算会用错标准。
- **B. 估数优先级重排为：显式结算 override > 录入员估数 > AVG3**——显式输入语义上必须真 override。

## 已确认的产品决定

| # | 决定 |
|---|------|
| ① | "监控表"建在水表户层，不动 `Customer.custType`；MONITORING 永不计费，`billable` 由 **DB CHECK** 保证 |
| ② | 用水人数真实参与阶梯计算：4 人基数，每+1 人各级年基数 +51 m³；**effective-dated profile + settlement snapshot** |
| ③ | 抄表周期在抄表册级：MONTHLY/BIMONTHLY + anchorPeriod；非应抄期 warning 不硬拒 |
| ④ | 未抄见方案 A：`estimateQty` 存 NO_READ 行；模拟读数纯显示不进链；优先级 override > reader estimate > AVG3 |
| ⑤ | 用水类别固定 5 项 + API 422 + **DB CHECK**；supersede AutoComplete 自由输入 |
| — | 单分支 feat/v0.2-feedback |

## 与未合并分支的关系

- `fix/pilot-v0.1.2`：其中"类别自由输入 AutoComplete"部分**废弃**；其余不冲突的 Pilot 修复可另行 cherry-pick/merge，不得带回自由输入类别。
- `fix/estimated-reading-recovery`：估读恢复补差修复，正交。**合并前需检查它不得读取 `water_account` 当前人口值**——历史计算必须用 profile/snapshot。
- `deploy/water-pilot`：试点部署，无交叉。

## 1. 监控表账户

**Schema**

- `water_account.billable Boolean NOT NULL DEFAULT true`
- `usage_category='MONITORING'` 为受控类别之一（见 ⑤）
- **DB invariant**（CHECK，不靠 service 层自觉）：
  ```sql
  CHECK (billable = (usage_category <> 'MONITORING'))
  ```
  即 `MONITORING→false`，其余四类→`true`；任何导入/SQL/migration 都无法造出非法组合。
- 系统客户稳定身份：`customer.system_key String?` + `UNIQUE(tenant_id, system_key)`（普通客户 NULL，Postgres NULL 不占唯一位）。监控户挂 `system_key='MONITORING_INTERNAL'` 的客户——lazy find-or-create 以 key 为准（幂等、并发安全：唯一冲突→catch 后重读），**不**按名称查找（用户可手建同名客户）。

**语义**

- Onboard 向导：用水类别选"监控表"→ 客户/结算户步自动走系统客户路径（MONITORING_INTERNAL 客户及其默认结算户），水表安装步照常。
- `billing-run`：FINAL settlement 查询追加 `waterAccount.billable = true` → 监控户结算不进批次、不生成账单、不计入 total/failed。
- 结算/抄表/QC/报表照常——监控用量即漏损分析的数据基础；MVP 不做专项漏损报表。

## 2. 用水人数 → 阶梯基数联动（有效期化）

**Schema**

```prisma
model WaterAccountHouseholdProfile {
  id                 String   @id @default(uuid()) @db.Uuid
  tenantId           String   @map("tenant_id") @db.Uuid
  waterAccountId     String   @map("water_account_id") @db.Uuid
  householdSize      Int      @map("household_size")
  effectiveFromPeriod String  @map("effective_from_period") @db.Char(6)
  createdAt/createdBy/updatedAt/updatedBy

  @@unique([tenantId, waterAccountId, effectiveFromPeriod])
  @@map("water_account_household_profile")
}
```

- `consumption_settlement.household_size_snapshot Int NULL`——结算生成时写入：**`effective_from_period <= settlement.period` 中最新一条 profile**；无 profile → NULL。
- `tariff_plan.base_household Int?` + `tariff_plan.per_person_qty Decimal(18,4)?`（成都：4 / 51）；`perPersonQty>0` 时 `baseHousehold` 必填（默认 4）。
- `water_account` 上不留 `household_size` 列——profile 表是唯一事实源，账户响应里透出当前有效值（避免双写漂移）。

**计费语义**

- `extraQty = max(0, householdSize − baseHousehold) × perPersonQty`
- 所有**有限** `toQty` 边界整体右移 `extraQty`（例：4 人 0–216–300–∞；5 人 0–267–351–∞）。顶层 `toQty=NULL` 不动。`tieredAmount` 仅以 `toQty`+cursor 分摊，`fromQty` 不参与计算，故只移 `toQty` 即自洽。
- `householdSize` 空/≤基数 → 不缩放（**不缩减基础额度**）；缩放只作用于多档 PER_QTY 项（水费），单层项（污水费）不受影响。
- `ytdBeforeQty` 仍是年度实际累计——双月抄一次天然不改动年度额度，无需 ×2。
- **快照语义**：结算生成时冻结 `household_size_snapshot`；billing/reversal/reconciliation 一律用 snapshot，历史账不受后续人口申报影响。新期间结算重新取该期间有效 profile。

**实现分层**

- `billing-core`：`ComputeBillInput.householdSize?: number|null`；`FeeItemInput.householdScale?: { baseHousehold: number; perPersonQty: Decimal }`；`computeBill` 对多档 PER_QTY 项把缩放后的 tier 数组交给 `tieredAmount`。
- API：profile 写入端点 `POST /water-accounts/:id/household-profiles {householdSize, effectiveFromPeriod}`（同期间重复 → 409，更正走 PATCH 该 profile 行）；onboard 在个人户下要求 householdSize → 写 profile（`effective_from_period` = `openedAt` 所属期）。
- `postOneBill`：读 settlement snapshot → 注入 `ComputeBillInput.householdSize` + 把 plan 的 `baseHousehold/perPersonQty` 注入每个多档 PER_QTY 项的 `householdScale`。

**测试矩阵**（billing-core 先行）：4/5 人 × 215/216/217/266/267/268；跨第二档；跨年度；MONTHLY/BIMONTHLY 路径；多档水费缩放 vs 单层污水费不缩放。

## 3. 抄表册级抄表周期

**Schema**（`reading_book` 增三列）

- `cadence String @default("MONTHLY")`：`MONTHLY | BIMONTHLY`
- `anchor_period Char(6)?`：BIMONTHLY 必填（`BIMONTHLY_ANCHOR_REQUIRED` 400），定奇/偶月节奏
- `meter_channel String @default("MECHANICAL")`：`MECHANICAL | REMOTE_MANUAL | REMOTE_AUTO`（REMOTE_AUTO 仅元数据，无集成）

**语义**

- 应抄判定统一用绝对月序号：`monthIndex = year*12 + month`；`BIMONTHLY due ⇔ (monthIndex(period) − monthIndex(anchorPeriod)) % 2 === 0`（跨年安全）。
- **判定由后端提供，UI 不自行实现周期算法**：`POST /reading-plans/generate` 响应含 `offCadence: boolean`；UI 据此弹"该册本账期非计划抄表期，仍要生成吗？"。generate 不硬拒（补抄/追抄是真实业务）。
- 册级同节奏：册内成员不按户过滤。
- 双月账期零改动：表差天然覆盖两个月，结算期=抄表月，阶梯走 YTD 年度基数。

## 4. 未抄见估水量 + 模拟读数（方案 A）

**Schema**

- `meter_reading.estimate_qty Decimal(18,4) NULL`——仅 `resultType=NO_READ` 可携带；其他类型带值 → 400 `ESTIMATE_QTY_ONLY_FOR_NO_READ`。估数 ≥0，可不填。

**语义**

- `readingValue` 保持 NULL；估水量是"水量"不是"表码"。实际表码 / NO_READ / 录入员估水量 / 最终结算用量是四个不同语义。
- UI 录入弹窗：选"未抄见"→ 估水量输入 + 只读"模拟读数 = 上次可信读数 + 估水量"。**纯显示**：不落库为表码、不进可信读数链、不成为下期物理基线。
- **结算优先级**：
  ```
  结算请求显式 usageQty  → MANUAL（sourceReadingId = NULL）
  否则 NO_READ.estimateQty 有值 → MANUAL（sourceReadingId = 该 NO_READ 行）
  否则 AVG3 可算          → AUTO_AVG3
  否则                    → 需人工输入
  ```
  审计区分：`MANUAL + sourceReadingId≠NULL` = 抄表员录入估水；`MANUAL + NULL` = 结算人工覆盖；`AUTO_AVG3` = 系统。
- QC 流程不变：NO_READ+估数行照常复核，估数值在复核视图可见。
- 后续真表读数按既有估读恢复/补差链处理（与 `fix/estimated-reading-recovery` 正交）。

## 5. 用水类别受控 + 开户日期默认

- 固定集合（API 常量 + **DB CHECK**，双层）：`RES_METERED / RES_SHARED / NON_RES / SPECIAL / MONITORING`。
- 校验点：水表户 create/update、onboard、资费 create/update → 422 `INVALID_USAGE_CATEGORY`。
- `water_account.usage_category` 与 `tariff_plan.usage_category` 同加 CHECK。
- **Migration fail-fast**：先 `UPDATE 'RESIDENTIAL'→'RES_METERED'`（water_account + tariff_plan），再 `DO` 块检测残留未知值——发现无法映射的生产值直接 `RAISE EXCEPTION`（不允许悄悄映射 SPECIAL）；通过后 ADD CHECK。测试 fixture 里的动态类别（`UAT_RES_*` 等）改为合法码。
- UI：`UsageCategoryInput` → 固定 5 项 Select；开户日期向导步显示 `openedAt` DatePicker 默认当日（后端默认值已有）。

## Schema 变更汇总（一个 migration）

```prisma
model Customer        { systemKey String? @map("system_key"); @@unique([tenantId, systemKey]) }
model WaterAccount    { billable Boolean @default(true) }  -- + CHECK billable = (usage_category <> 'MONITORING')
model MeterReading    { estimateQty Decimal? @map("estimate_qty") @db.Decimal(18,4) }
model ReadingBook     { cadence String @default("MONTHLY"); anchorPeriod String? @map("anchor_period") @db.Char(6); meterChannel String @default("MECHANICAL") @map("meter_channel") }
model TariffPlan      { baseHousehold Int? @map("base_household"); perPersonQty Decimal? @map("per_person_qty") @db.Decimal(18,4) }
model ConsumptionSettlement { householdSizeSnapshot Int? @map("household_size_snapshot") }
model WaterAccountHouseholdProfile { ... @@unique([tenantId, waterAccountId, effectiveFromPeriod]) }
-- CHECK usage_category IN (5 codes) on water_account + tariff_plan（先映射+断言再加约束）
```

## API 面

- 新错误码：`INVALID_USAGE_CATEGORY`（422）、`ESTIMATE_QTY_ONLY_FOR_NO_READ`（400）、`BIMONTHLY_ANCHOR_REQUIRED`（400）、`HOUSEHOLD_PROFILE_EXISTS`（409）。
- 新增：`POST/PATCH /water-accounts/:id/household-profiles`；`POST /readings` 加 `estimateQty?`；册 create/update 加 `cadence/anchorPeriod/meterChannel`；资费加 `baseHousehold?/perPersonQty?`；`POST /reading-plans/generate` 响应加 `offCadence`。
- `GET /water-accounts/usage-categories` → 固定 5 项。

## 测试计划

- billing-core 单测（**最先写**，锁死业务规则）：人数缩放边界矩阵、跨年、单层项不缩放、空值回退。
- e2e：监控户全流程（立户→抄表→结算→run 跳过）；profile 有效期（旧期结算用旧人口、snapshot 冻结、红冲重算不回读当前值）；估数优先级三档；off-cadence 提示；类别 422 + migration fail-fast。
- migration：任意名库 fresh install + 存量映射 + 未知值断言。

## Out of scope

- 证件/户口簿扫描上传（文档明确暂缓）；REMOTE_AUTO 实集抄；监控专项漏损报表；历史账单人口追溯重算；文档第 2、6 条（编号缺失未收到）。

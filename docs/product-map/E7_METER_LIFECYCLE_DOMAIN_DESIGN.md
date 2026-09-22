# E7 Meter Lifecycle V1 — Domain Design v0.1（Draft）

> 状态：Draft — 交 Product/Domain Gate 评审
> 日期：2026-09-22 · Base：`main @ 03ff08e`
> 冻结原则：**不新增表、不改结算/抄表引擎**。E7 是把已存在的生命周期能力收口成原子用例 + 补 org scope + 补销户漏洞 + 对象中心 UI。

## 1. 已对 main 核实的既有事实（E7 必须尊重，不重写）

代码核实（非文档推断）：

| 能力 | 现状 | 位置 |
|---|---|---|
| Meter 状态机 | `AVAILABLE→INSTALLED→MAINTENANCE→AVAILABLE\|RETIRED`；PATCH 只许库存态流转，INSTALLED 出入只能走装/拆 | `meter.service.ts` `PATCH_TRANSITIONS` |
| 装表 | `installTx`：户非 CLOSED、表 AVAILABLE（check-then-act + guarded `updateMany status='AVAILABLE'` 防并发双装） | `meter-installation.service.ts:99` |
| 拆表 | `removeTx`：`final_reading` 必填且 ≥ initial；`removedAt ≥ installedAt`；guarded flip ACTIVE→REMOVED；表回 AVAILABLE | `meter-installation.service.ts:157` |
| 拆表 fail-closed | removedAt 落入该户 FINAL settlement **或** POSTED/PARTIAL_PAID/PAID bill 期间 → `SETTLEMENT_PERIOD_ALREADY_FINALIZED` | 同上 `:196` |
| 远传绑定 | removeTx 同事务关闭 binding（`effective_to=null 或 >removedAt` → 收拢到 removedAt）；removedAt 后已有采集事件 → `BINDING_CLOSE_ORPHANS_EVENT` | 同上 `:246` |
| 期中换表结算 | settlement 按"installation 生命周期与期交叠"产出**每 installation 一条 component**；REMOVED 段以 `final_reading` 为止、prev 链按 installation 独立 | `settlement.service.ts:115-136` |
| 抄表解析 | entry 时重解析户上 CURRENT ACTIVE installation（`installed_at` 最新者）——`planned_installation_id` 只是生成期快照，期中换表后自动抄新表 | `meter-reading.service.ts:645` |
| onboard | 立户内含原子 install（复用 installTx） | `water-account.service.ts:531` |
| 谱系字段 | `meter.parent_meter_id` 已存在未使用；`installation.reason` 已含 REPLACE | schema `:578` |
| 读接口 | `GET /meters`（含 status/q 过滤）、`GET /meters/:id`（内嵌 installations+accountNo）、`GET /meter-installations`（waterAccountId/meterId/status 过滤） | controllers |

**结论：换表计费数学、抄表重解析、绑定关闭、幂等写、并发守卫全部已在 main。E7 不写这些。**

## 2. 已确认的缺口（E7 的全部工作面）

1. **无原子换表**：remove + install 两次调用非原子，中间态户上无表。
2. **customer 模块零 org scope**：`meter-installations`/`meters` 读写均无 `orgInScope`——scoped 员工可对出界户装/拆（**写路径泄漏，本 Epic 最高优先**）。
3. **CLOSE 不查 ACTIVE 表**：`transitionTx` 销户不检查安装关系 → 表卡 INSTALLED。
4. **UI 无换表/对象中心**：Meters.tsx 只有台账 PATCH + 独立装/拆 modal；WaterAccounts 详情无表务区。
5. 一户多表无呈现约定。

## 3. 原子换表：`POST /meter-installations/:id/replace`

### 3.1 请求

```jsonc
{
  "newMeterId": "uuid",            // 必填，须 AVAILABLE
  "finalReading": "1234.5",        // 必填，旧表止码 ≥ 旧 installation.initial_reading
  "initialReading": "0",           // 必填，新表始码（显式——两块物理表表盘独立）
  "replacedAt": "2026-09-22T10:00:00Z", // 可选，默认 now；旧 removedAt = 新 installedAt
  "reason": "REPLACE"              // 可选 ∈ REPLACE|FAULT|PERIODIC_CHECK，默认 REPLACE；NEW 拒绝
}
```

### 3.2 事务内步骤（严格顺序）

```
1. load installation（tenant+id）→ NOT_FOUND
2. assert installation.status = ACTIVE → INSTALLATION_NOT_ACTIVE
3. org scope 断言（§5）
4. 校验：finalReading ≥ initial_reading；replacedAt ≥ installedAt；
   replacedAt 所在期间无 FINAL settlement / POSTED-side bill
   （复用 removeTx 同一份 fail-closed 逻辑——抽共享私有方法，
   不复制粘贴第三遍）
5. load newMeter → METER_NOT_FOUND；status 断言 AVAILABLE
   （guarded flip 兜底并发）
6. load waterAccount → CLOSED → ACCOUNT_CLOSED（SUSPENDED 放行）
7. guarded flip：installation ACTIVE→REMOVED（removedAt=replacedAt,
   final_reading）——并发拆/换在此输
8. guarded flip：oldMeter → AVAILABLE；newMeter AVAILABLE→INSTALLED
9. binding 关闭（复用 removeTx 的 binding-close+orphan 检查）
10. create new installation（status=ACTIVE, installedAt=replacedAt,
    initialReading, reason, 同 waterAccountId）
11. newMeter.parentMeterId ??= oldMeterId（谱系，仅当为空）
```

### 3.3 不变量（事务级）

- 任一失败整笔回滚：不存在"旧已拆新未装"的中间态。
- 三块锁写按序：installation → oldMeter → newMeter → binding → new installation insert。两个并发 replace 同一 installation：后者在 step 7 `flipped.count=0` → `INSTALLATION_NOT_ACTIVE`。
- 换表同 idempotency key 重放：withOptionalIdem 层直接返回首响应，不二次进 service。
- **审计**：`req.auditBefore` = 旧 installation（含 meter）；响应体含 removed + installed 两个对象供 auditAfter。

### 3.4 为什么不允许 initialReading 自动=finalReading

两块物理表表盘独立——新表可能是新表（0）、库存旧表（上次拆下止码）、检定表（任意值）。结算链按 installation 分段（§1 事实），强绑相等会制造假读数。UI 并排显示两值让操作员自检，服务侧只校验各自合法域。

### 3.5 换表不产生"表间结转"

旧表段用量在**当期结算**自然结算（component 到 final_reading），新表段从 initial_reading 起。无结转分录、无余额迁移——纯物理操作。

## 4. 一户多表：V1 呈现语义冻结

- **数据层不动**：schema/结算/抄表早已多表就绪。
- **呈现约定**：
  - `当前表` ≡ 该户 `status=ACTIVE` 中 `installed_at` 最新者（与 `resolveActiveInstallations` 同一规则——展示语义和抄表语义一致，不产生两套"当前表"）。
  - 0 ACTIVE → 显示"未挂表"。
  - 1 ACTIVE → 常规当前表卡。
  - >1 ACTIVE → 如实列出全部 + `多表并行` 警示 Tag + 标注哪块是当前表。**UI 不静默隐藏**——隐藏会造成"以为没表其实有表"的资损盲区。
- **写入口约定**：户上有 ACTIVE 时 UI 隐藏"装表"只留"换表/拆表"（单表 UX）；API 层 installTx **不**加单表约束（一户多表是 phase-2 正向能力，不为 UI 收窄数据模型）。

## 5. Org Data Scope（customer 模块首次落地）

沿用既有惯例（settlement/billing/payment/prepayment 同一模式）：户 → reading_plan_item → reading_plan → reading_book.org_unit_id，**任一覆盖册出界 → 整户出界；无覆盖册 → 宽放**（off-book carve-out）。

| 接口 | 规则 |
|---|---|
| `GET /meter-installations`（无 waterAccountId） | 结果集按 scope 过滤出界户（同 E6 entries 的 NOT EXISTS 写法） |
| `GET /meter-installations?waterAccountId=`、`GET /:id` | 显式访问出界户 → `ORG_OUT_OF_SCOPE` 403（与余额接口一致：显式越界是 403 而非空集） |
| `POST /meter-installations`（install） | 写前 scope 断言 → 403 |
| `POST /:id/remove`、`POST /:id/replace` | 同上（经 installation→waterAccount 解析） |
| `GET /meters` 台账 | **租户级设备库存，不按册过滤**——meterNo/brand/caliber 是资产信息非客户信息 |
| `GET /meters/:id` | 设备档案照常；内嵌 `installations[]` 按 scope 过滤（出界户的整条 installation 不返回——连 accountNo 都不泄露） |
| `PATCH /meters/:id` | 库存态流转不查户 scope（操作对象是表不是户） |

**显式冻结**：本 Epic 只给 meter/installation 接口补 scope；waterAccount/customer 既有读接口的 scope 评估归 E8，不在此扩 scope。

## 6. CLOSED / SUSPENDED 与表务

| 户状态 | install | remove | replace | 说明 |
|---|---|---|---|---|
| NORMAL | ✓ | ✓ | ✓ | |
| SUSPENDED | ✓ | ✓ | ✓ | 停催是账务态，物理表务不停 |
| CLOSED | ✗（已有 `ACCOUNT_CLOSED`） | ✓ | ✗ | 销户后拆表必须可行——设备回收路径 |

**销户拦截（新）**：`transitionTx` 目标 CLOSED 时先查 ACTIVE installation：
- 存在 → `ACCOUNT_HAS_ACTIVE_INSTALLATION` 409，提示先拆表。
- 这是**行为变更**（main 允许带表销户）。理由：`final_reading` 是拆表强制事实，带表销户使该事实永远无法补录且表永久卡 INSTALLED（设备资产流失）。审批项：若评审认为销户拦截破坏既有流程，回退方案是允许销户但 meter 停留 INSTALLED + UAT 记录——不推荐。

## 7. RemoteDeviceBinding

- 拆/换继承 removeTx 既有语义（关闭 + 孤儿事件拒绝），replace 直接复用同一私有方法。
- **新 installation 不自动建 binding**：RemoteDevice 绑的是物理表位（installation），换表后设备是否还在现场是物理事实问题，需操作员通过既有 binding API 显式重建。自动复制会造成"设备已拆走但绑定还在"的假远传。

## 8. 接口面

| 方法 | 路径 | 权限 | 幂等 |
|---|---|---|---|
| POST | `/meter-installations/:id/replace` | `customer:write` | Idempotency-Key（同 install/remove 的 `withOptionalIdem`） |
| GET | `/meter-installations` `/:id` | `customer:read` | — |
| POST | `/meter-installations` `/:id/remove` | `customer:write` | 已有 |
| GET/PATCH/POST | `/meters*` | `customer:read/write` | 已有 |

新增错误码：`ACCOUNT_HAS_ACTIVE_INSTALLATION`（CLOSE 拦截）。其余全部复用既有码。

## 9. 实现面落点（预估，实现期可微调）

- `meter-installation.service.ts`：`replaceTx`；抽 `assertRemovalPeriodOpenTx` + `closeBindingsTx` 两个私有方法供 remove/replace 复用。
- `meter-installation.controller.ts`：`POST :id/replace` + 解析。
- `meter-installation.service.ts` `list/getById` + `install/remove/replace`：org scope 断言（共享一个 `assertInstallScopeTx`）。
- `meter.service.ts` `getById`：installations 数组 scope 过滤。
- `water-account.service.ts` `transitionTx`：CLOSED 目标时 ACTIVE-installation 检查。
- web：`WaterAccounts` 详情水表区；`Meters` 详情抽屉 + replace modal；types 补 `replace` wire。

## 10. 并发与一致性论证

- `replace ‖ replace`（同 installation）：step 7 guarded flip 序列化，输家 `INSTALLATION_NOT_ACTIVE`。
- `replace ‖ remove`（同 installation）：同上。
- `replace ‖ payment/settlement`：读数事实挂 installation 行，replacedAt 期界 fail-closed 挡住已结算期；未结算期内换表本合法，结算生成时按双 component 自然处理。
- `install ‖ install`（同 meter）：既有 guarded flip（count=0 → METER_NOT_AVAILABLE），replace 的 step 8 同构。
- 死锁：replace 的锁序 installation→meters→binding 与 remove 同向；不同 installation 的两个 replace 无共享行。

## 11. DB 不变量

无新表无新约束。断言级不变量（e2e 断言，不必加 CHECK）：

- 换表后旧 installation REMOVED 且 `removedAt = 新 installation.installedAt`；
- 旧表 AVAILABLE、新表 INSTALLED、`newMeter.parentMeterId = oldMeterId`；
- binding `effective_to = replacedAt`（若有）；
- 幂等重放不产生第二对 installation；
- replace 的 installation 行数守恒：拆一装一。

## 12. 测试矩阵

**API e2e（t17- 前缀 fixtures）**

1. 换表 happy path：installation/meter/谱系/时间点/审计断言全绿。
2. 换表 reason=FAULT/PERIODIC_CHECK 接受；reason=NEW → 400。
3. finalReading < initial → 400；replacedAt < installedAt → 400。
4. 落 FINAL 期 → 409 `SETTLEMENT_PERIOD_ALREADY_FINALIZED`；落 POSTED-bill 期 → 同。
5. newMeter 非 AVAILABLE → 409 `METER_NOT_AVAILABLE`；并发 second replace → 409 `INSTALLATION_NOT_ACTIVE`。
6. 幂等重放 → 同响应、无重复行。
7. 带 binding 换表 → binding 关闭；removedAt 后有已采集事件 → 409 `BINDING_CLOSE_ORPHANS_EVENT`。
8. CLOSED 户 replace → `ACCOUNT_CLOSED`；SUSPENDED 户 replace → 成功。
9. ACTIVE 表在户 → CLOSE → 409 `ACCOUNT_HAS_ACTIVE_INSTALLATION`；拆后 CLOSE → 201。
10. org scope：Branch A staff 对 Branch B 户 remove/replace → 403 `ORG_OUT_OF_SCOPE`；installation list 过滤；meter detail 内嵌 installations 过滤；无册户不受限；跨租户仍隔离。
11. 期中换表 → settlement 双 component（旧段=final_reading、新段自 initial_reading）——回归既有引擎。
12. 一户多表：双 ACTIVE fixture → list 返回全部 + detail 当前表=最新 installed_at。

**Playwright UAT（对应对应 §Acceptance S1–S10 切片）**

S3 原子换表、S5 fail-closed、S7 scope、S8 销户拦截为核心断言；S1/S2 为回归覆盖。

## 13. Not in Scope（冻结）

- 反向纠错（取消拆表/取消换表）。
- 检定计划与到期提醒、批量导入、GIS 呈现、资产折旧。
- 一户多表的抄表/计费语义升级（plan item 仍按户一条）。
- RemoteDeviceBinding 自动迁移。
- waterAccount/customer 其余接口的 org scope（E8 一并评估）。
- 换表时旧表直接置 MAINTENANCE/RETIRED 的联动选项（V1 保持拆下即 AVAILABLE，后续手工流转）。

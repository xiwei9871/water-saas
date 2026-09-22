# Epic E7 — Meter Lifecycle UI V1（表计生命周期）

> 状态：Draft — Product/Domain Gate 评审中
> 层级：L1 Core · 版本：v0.3.x（紧随 E6）
> 起草日期：2026-09-22
> 上游基线：docs/PRODUCT_MAP.md §2.1/§2.2/§2.3/§2.7
> 分支前提：从已合入 E6 的最新 main 切 `feat/meter-lifecycle-v1`，不 stacked。
> 本 Epic 定位：**后端生命周期能力大部分已在 main**（meter 状态机、装/拆、期中换表双 component 结算、绑定自动关闭）。E7 冻结的是缺口：原子换表、一户多表呈现语义、customer 模块 org data scope、销户挂表漏洞、对象中心 UI。

## User

- 营业员/抄表班组长：装表、拆表、换表、看某户"现在挂的什么表、历史挂过什么表"。
- 设备管理员：表计库存台账、送修/报废、看某块表"在谁家装过"。
- 收费员/客服：在 360° 里回答客户"你家表什么时候换的、旧表止码多少"。
- 跨营业所员工：只能操作本所册覆盖的户。

## Problem

水司日常高频操作是**换表**（周期轮换、故障更换），而不是独立的"拆+装"。现状把换表拆成两次调用：

- 非原子：拆成功、装失败 → 户上无表，抄表/结算立刻断链；
- 两次审计事件，说不出"这是同一次换表"；
- 操作员要手工保证新表初始读数、旧表止码、同一时间戳的一致。

另外还有三个已确认缺口：

- customer 模块（meter / meter-installation）**完全没有 org data scope**——Branch A 员工能对 Branch B 的户执行装/拆（写路径泄漏，比读更严重）；
- 销户（CLOSE）不检查 ACTIVE 安装关系 → 表永久卡 INSTALLED，设备回不了库存；
- 一户多表在数据层早已允许，但 UI 没有呈现语义。

## Core Scenarios

1. **周期换表（主场景）**：户上 ACTIVE 安装关系 → 营业员发起换表 → 一次操作：旧表记录 `final_reading`、新表以 `initial_reading` 挂上、同一时间点生效 → 旧表回 AVAILABLE（可检修/再装），新表 INSTALLED。**一个事务、一次审计**。
2. **故障换表**：同 1，只是 reason=FAULT；旧表拆下后直接送 MAINTENANCE（可在换表时顺带标记，或事后库存态流转）。
3. **期中换表的计费**：换表发生在结算期中间 → 该期 settlement 产出**两条 component**（旧表段 + 新表段），已有引擎原生支持，E7 不改结算逻辑。
4. **拆表（不换）**：销户前拆表、迁移拆表 → final_reading 必填；落在已 FINAL/已 POSTED 的期间 → fail-closed 409。
5. **销户**：户上有 ACTIVE 表时销户必须被拦（`ACCOUNT_HAS_ACTIVE_INSTALLATION`）——止码是业务必需事实，不允许"带着表销户"造成表永久挂死。
6. **远传绑定**：拆表/换表自动关闭该 installation 上的 RemoteDeviceBinding（既有行为）；换表**不**自动把设备绑到新安装关系（设备绑表不绑户，物理上要重新绑定）。
7. **库存流转**：AVAILABLE→MAINTENANCE（送修）→AVAILABLE（修复回库）/ RETIRED（报废）；INSTALLED 状态只能通过装/拆/换流转，PATCH 永不放行（已有，保留）。
8. **对象中心**：水表户详情看"当前表 + 安装历史"；表计详情看"当前挂哪户 + 挂过哪几户"。
9. **权限边界**：Branch A 营业员看不到、更不能动 Branch B 户的表务；ALL 管理员不受限。

## Business Rules

冻结规则：

1. **换表 = 原子业务用例**：`POST /meter-installations/:id/replace` 在**一个事务**内完成旧拆新装。绝不允许 UI 串两次调用拼出换表。
2. **读数链按 installation 独立**：旧表 `final_reading`（≥ 其 initial）与新表 `initial_reading`（显式输入，默认提示 0 或出厂读数）**不要求相等**——两块物理表的表盘各自独立，结算链也是按 installation 分段。UI 把两个输入并排展示防止抄错。
3. **换表时间点统一**：旧表 `removedAt` = 新表 `installedAt` = 同一 `replacedAt`（默认 now）。不冻结"旧拆周一新装周三"的 V1 场景——那是拆+装两次操作，不是换表。
4. **fail-closed 期界**（沿用 removeTx 既有规则，替换同效）：replacedAt 落入该户已 FINAL settlement 或已 POSTED/PARTIAL_PAID/PAID bill 的期间 → 409。历史补录走专用纠错流程，不进 V1。
5. **meter 状态机不变**：AVAILABLE→INSTALLED 只经由 install/replace；INSTALLED→AVAILABLE 只经由 remove/replace；MAINTENANCE/RETIRED 只在库存侧 PATCH。无新状态。
6. **新表必须 AVAILABLE**；旧表替换后 → AVAILABLE（不是 MAINTENANCE——是否送修由操作员随后单独决定，FAULT 换表不自动判废）。
7. **parentMeterId 谱系**：换表时若新表 `parentMeterId` 为空，写入旧表 id（表→表更换谱系，字段已在 schema）。
8. **installation.reason**：换表产生的新安装关系 reason 由请求指定（REPLACE 默认，FAULT/PERIODIC_CHECK 允许；NEW 不允许——换表语境下 NEW 是数据错误）。
9. **一户多表 V1 呈现语义**：API/数据层继续允许多 ACTIVE（不收紧）；**UI 按单表语义呈现**——户上有 ACTIVE 表时"装表"入口隐藏/禁用，只提供"换表/拆表"；若数据出现 >1 ACTIVE（历史/异常数据），列表如实展示并以"当前表 = installedAt 最新者"标注（与抄表解析规则一致），同时给出"多表并行"警示 Tag。
10. **CLOSED/SUSPENDED**：
    - CLOSED 户：禁止装表（已有）、禁止换表（replace 内部走 install 自然继承）；允许对已存在 ACTIVE 安装关系执行拆表（设备回收必须可行）。
    - SUSPENDED 户：装/拆/换均允许——停催是账务状态，物理表务照常。
    - 销户（CLOSE）：户上存在 ACTIVE 安装关系 → 409 `ACCOUNT_HAS_ACTIVE_INSTALLATION`，必须先拆表。（**行为变更**，见 Domain Design §9 决策记录。）
11. **RemoteDeviceBinding**：拆表/换表沿用 removeTx 语义——该 installation 上 effective_to 为空或晚于 removedAt 的 binding 一并关闭到 removedAt；存在 removedAt 之后已采集事件的 → `BINDING_CLOSE_ORPHANS_EVENT` 拒整笔。换表不给新 installation 自动建 binding。
12. **org data scope（本 Epic 必须补的洞）**：
    - `meter-installations` list/get：按"户→计划项→册 org"覆盖规则过滤——任一覆盖册出界则整户隐藏；无册户沿用既有宽放约定（与 E6 预存读接口一致）。
    - install/remove/replace：写前断言水表户 scope（同 assertAccountScope 惯例），出界 → `ORG_OUT_OF_SCOPE`。
    - `meters` 台账 list：设备库存属租户级资产，不按册过滤；meter detail 内嵌的 installations 数组按同一规则过滤出界户（不返回 accountNo 链接）。
13. **幂等**：install/remove 已有 Idempotency-Key；replace 同样走 `withOptionalIdem`，键控 route+body，重放返回首次结果。
14. **审计**：replace 是一次审计事件（before=旧 installation+meter，after=两条 installation+两块表）； meter/installation 的 createBy/updateBy 照惯例写。

## Data / State

不新增表。复用：

- `meter`（AVAILABLE/INSTALLED/MAINTENANCE/RETIRED；`parent_meter_id` 谱系）
- `meter_installation`（ACTIVE/REMOVED；`initial_reading`/`final_reading`/`reason`/`installed_at`/`removed_at`；location 字段不动）
- `remote_device_binding`（effective_to 关闭语义已有）
- `consumption_settlement` / `consumption_component`（期中换表双 component 已原生支持，不改）
- `meter_reading`（entry 时重解析 CURRENT ACTIVE installation，已支持换表，不改）
- `water_account`（CLOSE 时新增 ACTIVE-installation 检查，仅 service 层）

## UX / UI

- **WaterAccounts 详情**：新增"水表"区（E8 360° 的前身，先做单区不整 Tab 重构）：当前 ACTIVE 卡（meterNo/brand/caliber/initialReading/installedAt + 换表/拆表按钮）+ 安装历史表（全部 installation，倒序，含 final_reading/reason）。
- **Meters 页**：
  - 台账行 → 详情抽屉：设备档案 + 当前挂载户（若有）+ 安装历史（跨户）+ 状态流转按钮（仅库存态）。
  - 装拆记录卡：新增"换表"动作（对 ACTIVE installation 行）；replace modal：新表选择器（仅 AVAILABLE）、旧表止码、新表始码、生效时间。
- **一户多表**：>1 ACTIVE 时当前表卡显示"多表并行"警示，列表标注"当前表（抄表取最新）"。
- **错误码呈现**：`ACCOUNT_HAS_ACTIVE_INSTALLATION`、`SETTLEMENT_PERIOD_ALREADY_FINALIZED`、`BINDING_CLOSE_ORPHANS_EVENT`、`METER_NOT_AVAILABLE`、`ORG_OUT_OF_SCOPE` 前端按既有 apiErrorText 展示。

## Acceptance（UAT 切片）

- **S1 库存台账**：建表 → AVAILABLE；PATCH→MAINTENANCE→AVAILABLE→RETIRED 链路；INSTALLED 状态 PATCH 被拒。
- **S2 装/拆基线**：装表 → INSTALLED；拆表 final_reading 必填且 ≥ initial；拆后表回 AVAILABLE。
- **S3 原子换表（核心）**：户上 ACTIVE 表 → 一次换表 → 旧 installation REMOVED（final_reading、replacedAt）、新 installation ACTIVE（reason=REPLACE、同时间点）、旧表 AVAILABLE、新表 INSTALLED、parentMeterId 谱系、一条审计。
- **S4 期中换表计费**：换表后对该期生成 settlement → 两条 component（旧表段到 final_reading，新表段从 initial_reading 起）——验证既有引擎，不改代码。
- **S5 fail-closed**：拆表/换表 replacedAt 落入 FINAL settlement 或 POSTED bill 期间 → 409。
- **S6 远传绑定**：带 binding 的 installation 拆/换 → binding effective_to=removedAt；孤儿事件场景 → 409。
- **S7 org scope**：Branch A 员工对 Branch B 户 installation list 不可见、remove/replace → 403；无册户不受限；ALL 全见。
- **S8 销户拦截**：ACTIVE 表在户 → CLOSE → 409；拆表后 CLOSE 放行。
- **S9 幂等**：replace 同 key 重放 → 同一结果，不产生第二条 REMOVED/ACTIVE。
- **S10 一户多表呈现**（数据允许时）：双 ACTIVE 数据 → 当前表卡标注最新 + 警示。

## Out of Scope（V1 冻结）

- 一户多表的多表并行抄表/分量计费（plan item 已按户生成，多表读数归一并入一户模型——phase-2 再议）。
- 换表自动迁移 RemoteDeviceBinding（物理换设备需重新绑定）。
- 拆表/换表反向纠错（拆错了如何"取消拆表"——append-only 方向，V1 不做，走运维）。
- 表检定计划（periodic check 排程）、检定到期提醒。
- 批量换表导入。
- GIS/地图呈现（installation location 字段已在，V1 仅保留数据）。
- meter 资产折旧/采购管理。

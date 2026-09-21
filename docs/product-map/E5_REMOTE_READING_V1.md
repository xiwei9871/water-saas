# Epic E5 — Remote Reading Integration V1

> 状态：产品定义冻结稿（Product Gate 待审）
> 层级：L1 Core · 版本：v0.2.x（近期优先）
> 冻结日期：2026-09-21
> 上游基线：docs/PRODUCT_MAP.md §7.2、§11.2

## User

- 抄表员：关注远传数据是否按时到、哪些户没来数据需要补抄。
- 复核员（QC）：远传读数与人工读数走同一 QC 队列，异常仍要人工裁决。
- 营业员/管理员：处理设备绑定、查看采集失败原因、配置接入。
- 系统（SYSTEM）：Adapter 自动完成 事件→绑定→读数 的转换。

## Problem

郊县水司机械表与远传表长期并存。现状缺口：远传数据只停留在厂商平台里，结算仍依赖人工把数誊进系统——慢、易错、无审计。需要把远传数据**可信地**接入既有抄表主链，同时不提前背一个重型 IoT 平台。

关键风险（本 Epic 要防的）：

- 厂商重复推送 / 文件重复导入 → 同一读数重复入库；
- 设备档案与水表脱节 → 读数落错户；
- 远传异常（停走、负差、通信失败）被当成正常读数直接结算；
- Adapter 绕过 MeterReading/QC 直接写结算 → 破坏"事实与计算分离"护栏。

## Core Scenarios

1. **文件导入（参考实现 / Pilot fallback）**：抄表员或管理员上传厂商导出的 CSV/Excel，FileImportAdapter 解析为 Raw Event，系统按设备标识绑定水表，生成 REMOTE 读数进入 QC。
2. **Vendor API Pull**（框架支持，Adapter 后定）：定时或手动触发拉取厂商平台读数。
3. **Webhook Push**（框架支持，Adapter 后定）：厂商平台主动推送读数事件。
4. **设备绑定维护**：管理员把厂商设备标识绑定到 Installation；换表后产生新的有效期绑定段，历史事件按采集时间归属旧安装。
5. **未绑定设备**：事件到达但设备未绑定 → 进入"待绑定"队列，提示处理，不猜、不丢。
6. **异常读数**：负差、超阈值、厂商标记异常的读数 → 仍生成 MeterReading 但 QC 标记待复核（MANUAL_REVIEW），不直接进结算。
7. **远传断采回退**：本期某户无远传数据 → 计划项保持 PENDING，人工照常补抄/NO_READ 估水，远传链路故障不阻塞营业。
8. **重复数据**：同一文件重复上传、同一 Webhook 重发 → 幂等命中，不产生第二行事件、不产生第二条读数。
9. **晚到数据 vs 已确认人工实抄**：厂商补传历史数据到达时该位置已有 QC PASSED 的人工读数 → 事件落库并进入 CONFLICT，由复核员裁决，账务不自动变化。

## Business Rules

冻结规则（与 PRODUCT_MAP §7.2 一致，这里落成可验收语句）：

1. Adapter 只产出 Raw Remote Event；**绝不**直接写 Settlement/Bill。
2. 所有远传数据必须先落 Raw Event，再由转换层生成 `MeterReading(resultType='REMOTE')`；不允许跳过 Raw Event。
3. Raw Event 的 **identity 与 raw payload 永不可修改**；处理状态（processing state）允许演进，但每次状态变化/重放必须留审计。原始事实不可变，处理结果可演进——schema 形式（current-status 列 / 处理日志表）由 Domain 设计阶段决定，产品层不锁表结构。
4. 幂等模型：Adapter 输出 `externalEventKey`，唯一约束 `(tenantId, remoteSourceId, externalEventKey)`。厂商有稳定事件 ID/流水号时直接使用；没有时 Adapter 对规范化后的 `deviceKey + collectedAt + readingValue + 必要业务字段` 做 deterministic fingerprint。重复到达返回原事件，不新增行。
5. 设备绑定 **effective-dated**：`RemoteDeviceBinding { vendorDeviceKey, installationId, effectiveFrom, effectiveTo }`。事件按 `collectedAt` 解析当时有效的绑定段——厂商补传的历史数据落在事件发生时的安装上，不按当前绑定归属。
6. 设备未绑定（collectedAt 不在任何绑定段内）→ 事件状态 `UNBOUND`，进入待绑定队列；补绑定后允许重放生成读数，重放是同一事件的再处理，不产生重复。
7. 一个 Raw Event 至多生成一条 MeterReading（`eventId` 唯一关联）；该读数仍可能被 supersede 更正，但 supersede 链写 MeterReading，不回写 Raw Event。
8. REMOTE 读数与 ACTUAL 同权进入 QC；QC 拒绝 → 该读数不进结算，等人工处理。
9. **CONFLICT**：同一业务位置已有 `ACTUAL` 且 `QC=PASSED` 时，晚到 REMOTE 仅落 Raw Event 并进入 `CONFLICT`——不自动覆盖、不自动 supersede、不改变 plan item/effective reading/settlement。复核员明确"采用远传值"→ 创建更正读数/supersede；"保留人工值"→ conflict 关闭留痕。
10. 远传断采不改变计划项状态机；人工补抄永远是合法回退路径。

## Data / State

新增对象（产品层命名，schema 设计阶段细化）：

| 对象 | 状态机 | 说明 |
|---|---|---|
| RemoteSource | ACTIVE / DISABLED | 接入配置：type=FILE/API_PULL/WEBHOOK，厂商标识、凭据引用（不落明文）、拉取参数 |
| RemoteDeviceBinding | effective-dated 段（effectiveFrom/effectiveTo） | vendorDeviceKey → installation 绑定；换表产生新绑定段，旧段封闭保留；同一设备同一时刻至多一段生效 |
| RawRemoteEvent | RECEIVED → UNBOUND / CONVERTED / FAILED / CONFLICT | payload 原文 + 解析字段 + externalEventKey + 来源；payload immutable，状态演进有审计 |
| MeterReading（既有） | 沿用 | `resultType='REMOTE'`，`source` 记录来源 Adapter，`sourceEventId` 回链 Raw Event |

状态流转要点：

- `RECEIVED → CONVERTED`：正常路径（当时绑定段命中，无冲突）；
- `RECEIVED → UNBOUND`：`collectedAt` 无有效绑定段；`UNBOUND → CONVERTED`：补绑定后重放成功；
- `RECEIVED/UNBOUND → CONFLICT`：转换时发现该位置已有 QC PASSED 的 ACTUAL；`CONFLICT → CONVERTED`：复核员裁决采用远传（生成更正读数）；`CONFLICT → IGNORED`：复核员保留人工值；
- `→ FAILED`：解析失败/数据非法（保留原因，允许修复后重放——重放仍走幂等键，不产生重复）；
- UNBOUND/FAILED/CONFLICT 事件可重放或人工裁决，重放是同一事件的再处理，不是新事件。

## UI Entry

- **抄表 → 远传接入**：Source 列表（类型/厂商/状态/最近采集时间/成功率）、绑定管理（含有效期段）、事件流水（按状态过滤：全部/待绑定/失败/冲突/已转换）。
- **CONFLICT 裁决入口**：事件流水或 QC 视图内，复核员对冲突事件选择"采用远传值"（生成更正读数进 QC 链）或"保留人工值"（关闭冲突）。
- **抄表计划详情**：远传户在明细行上显示来源标识（REMOTE + 采集时间），与人工实抄区分。
- **QC 队列**：REMOTE 读数与 ACTUAL 同列，`sourceEventId` 可点开看原始事件。
- **异常中心（E9 落地时接入口）**：UNBOUND/FAILED 事件、断采户清单。

## Permission

| 操作 | 权限 |
|---|---|
| 配置 RemoteSource / 上传导入文件 | 管理员、营业员（metering:remote:manage） |
| 设备绑定/改绑 | 管理员、营业员（metering:remote:manage） |
| 查看事件流水/绑定 | 抄表员、复核员、收费员、管理员（metering:read） |
| REMOTE 读数 QC | 复核员（metering:qc，既有权限） |
| 人工补抄回退 | 抄表员（既有录入权限） |
| Adapter 写 Raw Event / 生成读数 | SYSTEM（服务身份，不走用户权限） |

## Audit

- Raw Event 本身即留痕：来源、payload、到达时间、幂等键、处理结果。
- 绑定/改绑、Source 启停、手工重放 → 审计日志（操作人、前后值）。
- 生成的 MeterReading 继承既有审计 + QC 链；`sourceEventId` 保证任一结算可回溯到原始报文。

## Acceptance

- 同一 CSV 重复上传两次：Raw Event 数不变，MeterReading 数不变（幂等命中证据可见）。
- 含未绑定设备的导入：该户事件 UNBOUND，其余正常转换；补绑定后重放生成读数。
- 换表后厂商补传旧表期间数据：按 `collectedAt` 命中旧绑定段，读数归旧 Installation，不落新表。
- 晚到 REMOTE 撞上已 PASSED 人工读数：事件 CONFLICT，账务不变；裁决"采用远传"才产生更正读数，"保留人工"则关闭。
- REMOTE 读数进 QC；QC 拒绝后该户结算不使用它。
- 远传断采户：人工补录 ACTUAL 正常，结算走人工值。
- 全流程可从结算分量 → MeterReading → Raw Event → 原始行逐级回溯。
- e2e 覆盖：重复导入、未绑定、异常读数 QC、断采回退、绑定改绑后历史归属不变。

## Not in Scope

- 厂商协议栈解析（DL/T645、CJ/T188 等）、集中器/采集器管理、固件升级、远程阀控、设备健康监测——全部属 v0.4+ 完整 IoT 平台。
- 第一个真实 VendorXAdapter 的厂商接口细节（等 Pilot 水司提供接口文档后另行冻结）。
- 远传实时告警推送、短信通知。
- 双向通信（拉数以外的任何下行指令）。

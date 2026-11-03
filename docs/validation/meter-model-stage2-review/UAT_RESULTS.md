# UAT 结果（真实服务：Nest API:3000 + Vite Web:5173 + watersaas_test）

环境：API `nest start` 连 watersaas_test；Web `vite dev`（/api→:3000 代理）；
浏览器 Chromium（playwright-cli）。登录 t9-water / t9-admin。

## 业务链实测（uat_flow.sh 逐步 HTTP）

| 步骤 | 操作 | 结果 |
|---|---|---|
| 1 | 报建申请 BZ202611000033（meterQty=2 + DN15×2） | SUBMITTED |
| 2 | SURVEYED→APPROVED→INSTALLING | 各 201 |
| 3 | install-meters 填报 UATM01/UATM02 | 201 |
| 4 | allocate 放号 2 户（区94·段07·每月） | count=2 |
| 5 | activate 上号（四复核 REVIEW_INCOMPLETE→补齐后 PENDING_COMPLETE） | 201 |
| 6 | complete-info 挂客户/结算户+区段频次 | NORMAL，94/07/MONTHLY |
| 6b | A3 缺陷：completeInfo 未入册 → 修复后 PATCH 同步，book_meter 2 行 | 94/07 |
| 7 | auto-generate → planDate 2026-11-03 seg=02 | OK |
| 7b | generate 段 07 计划（2 项）→ start | OPEN→IN_PROGRESS |
| 8 | 两户录数 12.5m³ 带 photoRef → 计划自动 DONE | PENDING_QC×2，photo 落库 |
| 9 | 问题上报 FAULT SG202611000025 → approve→dispatch | DISPATCHED |
| 9b | 问题上报 METER_GROUP_CLEANING SG202611000026 → approve→dispatch→execute | EXECUTED |
| 10 | VIOLATION FIELD 上报（TAMPER+照片+描述） | 建档成功 |
| 11 | 浏览器真实提交清洁工单（MobileReading 问题上报模块） | SG202611000027 PENDING_APPROVAL |

## 浏览器页面证据（截图）

- uat-route-patterns.png：区号管理 + 路线模式弹窗（保存/应用/设默认/删除）
- uat-redistribute.png：抄表计划「超段均分」弹窗
- uat-mobile-modules.png：移动端三模块（抄表作业/问题上报/装表上户）
- uat-mobile-report.png：问题上报模块（户号/类型/描述/拍照/提交）

## 核验项

- Web/移动真实 HTTP 成功：登录 + 全部业务链步骤 200/201
- 数据库核对：book_meter(94,07)=2、meter_reading photoRef 落库×2、
  service_order payload.photoRefs 落库、计划 status DONE
- 中文错误：REVIEW_INCOMPLETE / SERVICE_TYPE_INVALID /
  VIOLATION_PHOTO_REQUIRED / PATTERN_ZONE_OUT_OF_SCOPE 均中文码返回
- WebKit 浏览器：NOT_VERIFIED

# Stage 2.1 验收：P0 修复 + UI 收尾 + UAT（meter-model-stage2-review）

- 仓库 `xiwei9871/water-saas` · 分支 `fix/meter-model-stage2-review`
- 基线：`feat/meter-model-r20261102-stage2` @ `22ce300`
- 文件：README / TEST_REPORT / UAT_RESULTS / CHANGE_MANIFEST /
  test-e2e-full.log / uat-*.png（4 张真实浏览器截图）

## P0 修复（全部落地，专项 e2e 32/32 通过）

- **P0-1 monthWorkdays 真实天数**：`daysInMonth()` 按真实 28/29/30/31
  遍历（闰年 2-29 正确）；`tenant-calendar` 例外查询边界改月末真实日
  （原固定 `-28` 会漏 29–31 日例外）。2026-11=21 工作日/预留6→15 段、
  2027-02=20→14 段、2028-02=21→15 段、2027-04=22→16 段（专项断言）。
- **P0-2 问题上报通道对齐**：移动端上报类型改为真实 SERVICE_TYPES
  （FAULT/METER_GROUP_CLEANING/SITE_RECTIFICATION）；`VIOLATION` 走
  `POST /violations` 稽查通道（FIELD 须描述+照片+字典类型）；
  照片字段 `payload.photoRefs`/`photoRefs` 入库。未注册类型（REPLACE）
  → `SERVICE_TYPE_INVALID`；稽查登记 `VIOLATION_INSPECT_ONLY`。
- **P0-3 路线模式组织范围**：list 过滤（scoped 只见子树册有户的区号）、
  save/apply/setDefault/remove 均 `assertZoneReadable` +
  apply 逐户册组织校验；跨子树写 → `PATTERN_ZONE_OUT_OF_SCOPE`。
- **P0-4 billable 状态一致**：退号显式 `billable:false`（状态派生）；
  CHECK 覆盖 PENDING_ASSIGN/PENDING_COMPLETE/RETURNED；
  测试逐项断言 NORMAL→true、PENDING_ASSIGN→false、RETURNED→false、
  CLOSED 非监控→true；PATCH 不得改 status（状态机保护断言）。
- **A3 缺陷修复（UAT 发现）**：`completeInfo` 写区段但未同步册成员——
  补 `syncZoneBook` 调用，与 updateTx 同一不变式。

## Part 2 UI 收尾（真实可操作）

- 区号管理：每区「路线」按钮 → 模式弹窗（保存当前顺序/应用/设默认/删除）
- 抄表计划：「超段均分」弹窗（区/账期/源段/目标段 → POST redistribute，
  结果数量回显）+ 详情调序（上移/下移）+ 已抄项「照片」查看
- 移动端：三模块「抄表作业/问题上报/装表上户」；问题上报独立模块
  （户号+类型+描述+照片 → 工单或稽查）

## Part 3 浏览器 UAT（真实服务：API:3000 + Web:5173 + watersaas_test）

完整链路实测通过（uat_flow 逐步 HTTP + 截图）：
报建 BZ202611000033 → 审批×3 → 填报水表×2 → 放号×2(区94段07/每月)
→ 上号(四复核) → 补录(挂客户/结算户,区段频次入户+自动入册)
→ auto-generate(次日 11-03 段02) + generate 段07计划(2项)
→ start → 录数×2(带照片,photoRef 落库) → 计划自动 DONE
→ 问题上报(FAULT SG25 + 清洁 SG26 approve/dispatch/execute→EXECUTED)
→ VIOLATION 稽查建档(FIELD,照片必附)
→ 浏览器端真实提交清洁工单 SG202611000027(PENDING_APPROVAL)

## 测试汇总

| 项 | 结果 |
|---|---|
| api `pnpm build` | PASS |
| web `pnpm build` | PASS |
| 专项 spec | **32/32 PASS**（P0-1×5/P0-2×6/P0-3×1/P0-4×1 + Stage2 20） |
| 全量 e2e | 682 例：**PASS 678 / FAIL 4**（dma、e10 基线存量 +
  exception-center、meter-lifecycle 共享库顺序 flake——两例
  单跑 54/54 全绿，非回归） |
| 浏览器 Chromium | UAT 全链路通过（截图 4 张） |
| WebKit | NOT_VERIFIED（未执行） |

## 已知限制（如实）

- 路线模式列表的组织过滤为「区号下有子树册内户即可见」粒度——
  户级粒度差异（同区跨组织）下 scoped 可见模式但 apply 仍逐户拦截。
- FAULT 工单 execute 需换表要素（newMeterId/止码等），UAT 走到
  DISPATCHED；全闭环由清洁工单验证（EXECUTED）。
- 全量串行跑仍有 2 例顺序敏感 flake（共享库残留导致单文件隔离通过）。
- P3009 迁移残留继续只读审查未 resolve；未合并 main/未部署。

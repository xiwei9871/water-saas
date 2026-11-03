# Stage 2.1 修改清单（相对 22ce300）

## API（6）
- `src/common/metering-model.ts`：+daysInMonth()；monthWorkdays 真实天数遍历
- `src/modules/metering/tenant-calendar.controller.ts`：例外查询边界改月末
- `src/modules/metering/route-pattern.service.ts`：scopedWaIds/assertZoneReadable；list/save/apply/default/remove 全范围校验
- `src/modules/installation/allocation.service.ts`：退号显式 billable:false；completeInfo 补 syncZoneBook（A3 缺陷）
- `test/meter-model-r20261102.e2e-spec.ts`：+12 例 P0 专项（32 总）

## Web（3）
- `pages/m/MobileReading.tsx`：问题上报四类真实通道（FAULT/CLEANING/
  RECTIFICATION 工单 + VIOLATION 稽查 + 照片 photoRefs + 违章类型字典）
- `pages/system/ReaderZones.tsx`：路线模式管理弹窗（保存/应用/默认/删）
- `pages/metering/ReadingPlans.tsx`：超段均分弹窗 + 已抄项照片查看

## 验收
- `docs/validation/meter-model-stage2-review/`（README/UAT_RESULTS/
  TEST_REPORT/CHANGE_MANIFEST/test-e2e-full.log/uat-*.png×4）

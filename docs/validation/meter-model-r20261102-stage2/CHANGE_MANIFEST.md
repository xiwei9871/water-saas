# Stage 2 修改清单（相对 Stage1 HEAD eb4ef34）

## 新增
- `apps/api/prisma/migrations/20261103000000_plan_gen_run/`（A1 运行记录）
- `apps/api/test/meter-model-r20261102.e2e-spec.ts`（20 例专项）
- `docs/validation/meter-model-r20261102-stage2/`

## 修改（后端）
- `prisma/schema.prisma`：PlanGenRun 模型
- `src/common/metering-model.ts`：业务日字符串时区化（bizDayStr/parseBizDay/addBizDays）+ nextWorkday 45 天窗口
- `water-account.service.ts`：A3 区/段清空解除册成员
- `allocation.service.ts`：A4 meterQty 严格校验 + 批准量/安装明细上限
- `install.service.ts`：R11 申报 meterQty/caliberDetails 落库+校验
- `meter-reading.service.ts`：routeKey 学习失败记日志
- `reader-zone.service.ts`：A5 员工组织子树校验
- `reading-book.service.ts`：SELECT 补 zoneNo/segNo
- `reading-plan.controller.ts`：auto-generate 支持 baseDate
- `reading-plan.cron.ts`：空租户告警 + 运行日志
- `reading-plan.service.ts`：A1 下一工作日+运行记录；A2 reorder 行锁/两阶段/同集合重贴/终态禁改；scoped 册过滤
- `route-pattern.service.ts`：apply 组织权限
- `tenant-calendar.controller.ts`：业务日边界
- `vitest.config.e2e.ts`：fileParallelism:false

## 修改（前端）
- `api/types.ts`：户 zoneNo/segNo/cadence/routeKey/退号字段
- `Onboard.tsx`：区号/段号/频次 + R10 文案
- `WaterAccounts.tsx`：区段/频次编辑 + 退号按钮
- `Applications.tsx`：申请数量/口径明细/填报水表/放号区段频次/上限 9999
- `MobileReading.tsx`：三模块 + 独立问题上报
- `ReadingPlans.tsx`：调序弹窗（上移/下移→reorder）

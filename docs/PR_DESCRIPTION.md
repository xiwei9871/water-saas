# MVP — water-utility SaaS (T1–T16 全部完成)

> 有 remote 后：`gh pr create --title "MVP: water-utility SaaS (T1–T16)" --body-file docs/PR_DESCRIPTION.md`
> 合并方式：**merge commit**（保留 T1–T16 任务历史，不 squash）。

## 范围（Scope）

T1–T16 完整 MVP，41 commits / 194 files / +48k 行：

- **基础**: Prisma schema + PostgreSQL RLS 多租户（`tenant_id` + forced RLS + `ws_app` 受限角色）、IAM（JWT auth + 权限 + orgScope + 审计日志 + 幂等键）。
- **客户域**: 客户/结算户/水表户三户模型、装拆表生命周期、四步 onboard。
- **抄表域**: 抄表册/成员、快照式抄表计划、实抄/远传/估抄/异常读数、QC、supersede 更正链。
- **结算/计费**: consumption settlement（AVG3 估抄、rollover、supersede 排除）、资费计划（阶梯/版本冻结/激活）、`billing-core` 纯函数引擎、开账批次（DRAFT→POSTED 同步多事务）、账单红冲/换票。
- **收费域**: 柜台收款 + 精确分摊 + 部分支付、追加式红冲、收据、收银员日结、欠费探针。
- **报表**: 抄表日报、收费日报、应收月报、实收月报、回收率；integration 端口 stub。
- **Web**: 登录/布局/权限路由 + 系统管理 + 客户/抄表/结算/计费/收费/报表全部页面。

## 验证（Verification）

| 项 | 结果 |
|---|---|
| `pnpm -C apps/web lint` / `pnpm -C apps/api lint` | 0 warnings / 0 errors |
| `pnpm -r build` | 全绿 |
| `packages/billing-core` 单测 | 63/63 |
| API 单测 | 5/5 |
| API e2e | **219/219**（每 spec 单跑验证；全量并行跑有已知 flake，见 Known Issues） |

**发布 Gate（已通过）**:

1. **Fresh install**：全新空库 `watersaas_rc` → `prisma migrate deploy`（全部 migration 干净应用）→ `db seed`（2 租户 / 22 权限码 / 36 RLS 策略）。
2. **生产模式**：`node dist/main`（NODE_ENV=production，ws_app@RC 库）+ `vite preview` 静态产物 + `/api` 代理——全部 200/201。
3. **跨模块业务闭环**（prod build + fresh DB 真实跑通）：登录 → 资费激活 → onboard → 抄表册 → 计划生成/开始 → 实抄录入 → QC → 结算 FINAL → 开账 POSTED（12m³×3.00=3600分）→ 欠费探针=3600 → 收款分摊 → 收据打印 → 日结 → cashier-daily/ar-monthly/collected-monthly/recovery-rate 全部返回正确口径。
4. **E2E flake 已固化**为 `docs/known-issues.md`（有 remote 后转 issue）。

## 终审结果（Final Review）

跨切面终审（schema/migration 一致性、RLS 覆盖、租户隔离、权限字典一致性、幂等/金额纪律、错误面、死端、配置）：**SHIP-WITH-NITS** — Critical 0 / Important 0，5 个 Minor 已全部修复（`1744ddb`）。

每任务独立评审记录：T3–T16 各任务均经 implement→review→fix→re-review 闭环；高风险任务（T9/T10/T11/T12）额外过数据完整性复审。

## 已知项（Known Issues — 不阻塞合并，见 `docs/known-issues.md`）

- **并行 e2e flake**：12 个 spec 共享 `watersaas_test` 并发执行，偶发 1–4 个跨套件干扰失败；每个 spec 单跑全绿。建议后续 per-spec 独立库或串行。
- **REPLACE-of-REPLACEMENT 误报 422**：病态三连换票场景，fail-closed 方向（宁可拦不错收）。
- **JWT ≤15min 冻结窗口**：scope/禁用状态嵌在 access token 内，刷新路径有复查；文档化接受风险。

## 合并后动作

- 打 tag `v0.1.0-mvp`；此后 `feat/mvp` 冻结，进入 MVP 后缺陷修复/增强迭代。

Generated with [Devin](https://devin.ai)

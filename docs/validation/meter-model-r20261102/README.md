# 验收材料：1102 抄表业务模型重构（R1–R15 阶段一）

- 仓库：`xiwei9871/water-saas`
- 分支：`feat/meter-model-r20261102`
- 基线：`6b08db5ac1ae4c4cfc68c78dba9311164cd54171`
- HEAD：`6552c7dfb66913adf264fae253d10ae41aa30cf4`
- 本轮提交：
  1. `5cf48b0ac967c4ce12b76286095986f6a7a14df1` — feat(metering): 1102 抄表业务模型重构 R1-R15 阶段一落地
  2. `6552c7dfb66913adf264fae253d10ae41aa30cf4` — fix(metering): 回归修正——放号闸门放宽与册级频次告警恢复、R10 用例更新
- 远端分支：`origin/feat/meter-model-r20261102`（普通推送，未强推、未触碰其他分支）
- 本目录文件：
  - `README.md` — 本文件（汇总）
  - `CHANGE_MANIFEST.md` — 修改清单（相对基线）
  - `MIGRATIONS.md` — Prisma 迁移路径与现状（含 P3009 记录）
  - `TEST_REPORT.md` — e2e 汇总 + 失败归因 + 复现命令
  - `test-e2e-full.log` — 全量 e2e 原始输出

## 结论（证据详见各文件）

| 项 | 结果 |
|---|---|
| api `pnpm build`（nest build） | PASS |
| web `pnpm build`（tsc -b && vite build） | PASS |
| api `pnpm lint`（oxlint） | PASS（仅既有 warning，无 error） |
| api e2e 全量 650 例 | PASS 640 / FAIL 10 / SKIP 0 / ERROR 0 |
| 失败归因 | dma+e10 = 基线存量失败（`6b08db5` 上复现，非本轮引入）；service-order 8 例 = 并行共享测试库污染 flake（分支代码单跑 13/13 PASS，基线单跑亦 PASS） |
| 合并 main | 未做（按指示） |
| 生产部署/生产库 | 未触碰（按指示） |

## 未在本轮完成（下轮任务）

- Onboard/用水户档案/报装多口径明细/计划调序 UI；APP「问题上报」独立模块；R9 照片查看增强
- dma/e10 两例存量失败定位修复（与本轮功能无直接关联）
- dev 库 `_prisma_migrations` 历史失败行（见 MIGRATIONS.md），未经确认不处理

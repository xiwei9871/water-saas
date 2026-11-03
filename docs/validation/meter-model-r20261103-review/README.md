# 20261103 核查报告修订落实 — 验收记录

分支：`feat/meter-model-r20261103-review` @ `184f473d83ec947f9d802ff207e255dec37ffa94`
部署：stock-prod 192.168.3.185:5185（pilot `water_pilot_v012`，迁移 52/52 全应用）

## 总清单 15 项状态

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 放号分栏清单 | 已实施 | `CaliberDetailsInput`（默认两栏、增加一栏、可删、口径下拉支持关键字）Applications.tsx |
| 2 | 删表计口径 | 已实施 | 放号弹窗无 caliber 字段；后端 AllocateInput 已删 |
| 3 | 数量自检中文提示 | 已实施 | `口径明细合计 N 与放号数量 M 不一致` 前端 + `CALIBER_DETAILS_MISMATCH` 后端 |
| 4 | 抄表员→区号带入 | 已实施 | 选 readerId 后只读回显绑定区号；后端 allocate 以抄表员绑定区号为准 |
| 5 | 段号/频次移上号 | 已实施 | 放号弹窗已无两字段；上号弹窗新增（段 01–16 下拉、频次默认每月）+ ActivateInput |
| 6 | 取消归集模式 | 已实施 | collectMode 参数不再读取；syncZoneBook 统一区段（段号缺即清册成员+补赋任务）；参数 UI 已撤 |
| 7 | APP 异常上报跳转 | 已实施 | 抄表作业按钮直切「问题上报」分段 + 当前户号带入；弹窗与死码删除 |
| 8 | 上号复核重构 | 已实施 | 四项=用户档案号/口径/地址/用户名；后端 review 校验同步 |
| 9 | 口径字典统一 | 已实施 | `CALIBER_OPTIONS` DN15~DN200 单一出处，showSearch 关键字 |
| 10 | R12 安装填报提前 | 已实施（原已落地） | `INSTALL_INFO_REQUIRED` 闸门 + 填报水表入口（审计仅查前端误判） |
| 11 | R5 自动生成 | 已实施（后端） | cron+`auto-generate`+`plan_gen_run`；生产需 `CRON_TENANT_IDS` 配置（环境项） |
| 12 | R7 区段号编码 | 已实施（原已落地） | bookNo=zone+seg（`zoneSegCode`） |
| 13 | R4-2 远传区号 | 已实施（原已落地） | `REMOTE_ZONE_NO=111/YC`，计划生成排除 `isRemoteZone` |
| 14 | 两号合一 | 已实施 | `archive_no` 列删除（迁移）；放号只出 accountNo；全系统「户号→用户档案号」统一 |
| 15 | 上号水表号下拉 | 已实施 | `/water-accounts/:id/meter-candidates`（出库未装+本单填报）；AutoComplete 选中带入要素 |

## V1–V16 对应

- V1–V9、V15：前端实现 + 专项 spec（meter-model 32 例 / account-allocation 9 例，合计 41/41 PASS）
- V10–V13：后端既有实现复验（审计误判「未实施」系只查前端包）
- V14：迁移 `20261103120000_archive_no_merge` + 全链路去除引用
- V16 回归：41/41 PASS；全量 e2e 待 CI 跑完为准

## 部署记录

- 备份：`backups/pre-1103-20261103-172658.dump`（820KB）
- 迁移：pilot `water_pilot_v012` 一次成功（无 P3009；测试库手工登记，历史失败行未动）
- 冒烟：登录 OK、`/water-accounts`、`/metering/calendar`（已不返回 collectMode）200

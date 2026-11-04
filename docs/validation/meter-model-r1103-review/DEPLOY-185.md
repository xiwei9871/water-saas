# 185 部署记录 — fix/meter-model-r1103-review

| 项 | 值 |
|---|---|
| 部署 SHA | `62dd6c3bb08c8d04db84bf66b1bf20d82ee8bca1` |
| CI | run 41753477765 **全绿（684/684）** — https://github.com/xiwei9871/water-saas/actions/runs/41753477765 |
| 访问地址 | http://192.168.3.185:5185 |
| 数据库 | water_pilot_v012，迁移 **52/52 已应用无待办**（本修复版无新迁移） |
| 升级前备份 | `backups/pre-fix1103-20261104-092219.dump`（820KB，pg_restore --list 校验 750 TOC 项有效） |
| 数据 | 保留现有试点数据，未重置/未 seed |

## 冒烟验证（部署后实测）
web 200；登录 OK（cd-water 管理员真实密码）；/water-accounts、/install/applications、/reading-plans、/reading-zones/options、/metering/calendar 全部 200。

## 本版修复内容
P0-1 多户申请仅全部办结才 COMPLETED；P0-2 多区号抄表员放号须显式选区；
P1-1 移动端上号与桌面端对齐（候选+段号频次）；P1-2 候选端点组织权限；
P1-4 审计写入等待落库；历史 archive_no 映射留存 archive-no-map.csv。

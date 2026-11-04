# 185 部署记录 — feat/meter-model-r20261104-review

| 项 | 值 |
|---|---|
| 部署 SHA | `2d31ac4e08684e7a7763aad30149cb132195b258` |
| CI | run 41792348639 **全绿** — https://github.com/xiwei9871/water-saas/actions/runs/41792348639 |
| 访问地址 | http://192.168.3.185:5185 |
| 数据库 | water_pilot_v012，迁移 **53/53**（新挂 20261104120000_r1104_review：drop pending_caliber + add use_addr + 旧用水类别并入） |
| 升级前备份 | `backups/pre-1104-20261104-154404.dump`（822KB） |
| 数据 | 保留现有试点数据，未重置/未 seed |

## 冒烟验证（部署后实测）
web 200；登录 OK；/water-accounts、/install/applications、/reading-plans/gen-runs（新）、/reading-zones/options、/metering/calendar 全部 200。

## 本版内容
用水类别下拉去重（5 受控值）；国家法定工作日历（手动例外覆盖）；
总分表产销差命名；上号重构（放号不预分配口径、表号带出三要素、
新增用水地址）；统一查询三态排序；口径数值排序；自动生成运行记录卡片。

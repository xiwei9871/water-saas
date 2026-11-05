# 185 部署记录 — r1105v2（9fcbc07）

- 部署 SHA: `9fcbc07223d5cc7b8edc592e31fd48b862feea42`（feat/meter-model-r20261104-review2）
- 时间: 2026-11-05 14:1x；备份: `backups/pre-1105-20261105-141208.dump`（888KB）
- 迁移: `20261105000000_book_r13_r7` 应用账号无 ALTER 属主权（42501）→ 按既有做法 postgres 属主手工执行 + `migrate resolve --applied` 登记；status = up to date
- 数据事实: 册区段无重复，book_no 改写 UPDATE 0 行；三列（schedule_day/cadence/anchor_period）已删
- 冒烟: web 200；cs-water 登录 OK；water-accounts/install-applications/reading-plans/reading-books/gen-runs/reading-zones/options/calendar 全 200
- 数据保留: 未重置未 seed；cd-water/xh-water/cs-water 均在

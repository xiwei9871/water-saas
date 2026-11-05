# 185 部署记录 — r1105v2（9fcbc07）

- 部署 SHA: `9fcbc07223d5cc7b8edc592e31fd48b862feea42`（feat/meter-model-r20261104-review2）
- 时间: 2026-11-05 14:1x；备份: `backups/pre-1105-20261105-141208.dump`（888KB）
- 迁移: `20261105000000_book_r13_r7` 应用账号无 ALTER 属主权（42501）→ 按既有做法 postgres 属主手工执行 + `migrate resolve --applied` 登记；status = up to date
- 数据事实: 册区段无重复，book_no 改写 UPDATE 0 行；三列（schedule_day/cadence/anchor_period）已删
- 冒烟: web 200；cs-water 登录 OK；water-accounts/install-applications/reading-plans/reading-books/gen-runs/reading-zones/options/calendar 全 200
- 数据保留: 未重置未 seed；cd-water/xh-water/cs-water 均在

# 185 部署记录 — r1105v3（f527144）

- 部署 SHA: `f5271446efaa31359d303dd5de0e96d804071658`
- 备份: `pre-1105v3-20261105-160432.dump`（889KB）
- 迁移: `20261106000000_prepay_warn`（settle_account + prepay_warn_cent）属主执行 + resolve 登记；status=up to date
- 冒烟: cs-water 登录 OK；`GET /prepayments/accounts` 200；租户参数 prepay.warn.* 写入成功；`?lowOnly=1` 返回不足户（warn+accountNos 档案号）
- X8 实测: 新建 DN50 → checkPeriodYears=2；X6 实测: 区号07 PATCH readerId=null → 200
- X7 说明: service-order.cron scanCheckDueDaily 每日02:00扫 lastCheckDate+checkPeriodYears 到期建 PERIODIC_CHECK 工单；未配 CRON_TENANT_IDS 时枚举全部 ACTIVE 租户

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

# 185 部署记录 — r1106（f0f9ab5）

- 部署 SHA: `f0f9ab58d7328dd80f0604a708433772f7c4c80e`；备份 `pre-1106-*.dump`
- 迁移: 无新迁移（字典为数据回填）；sys_dict 已在线补 VIOLATION_TYPE/BANK_CODE/METER_CALIBER（三租户）
- 实测: `?usageCategory=MONITORING`→0（过滤生效）；meterRole=MASTER 持久化+DN100→2年；ops-yearly 行含 openingArrears；POST /violations THEFT→201

# 185 部署记录 — r1106v4（866fec8）

- 部署 SHA: `866fec8a991244cc7a340a651a8d07f5dfd9500d`；备份 pre-1106v4-*.dump
- D23 实测: /tasks?status=CLAIMED→1 / PENDING→76 / DONE→16，过滤生效
- v4 复核: D20 家庭人口按钮/弹窗已存在；D21 /tasks/events SSE 已实现；D22 收费台档案号直搜已存在

# 185 部署记录 — r1106v5（c684ab0，M1~M18 一次性提交）

- 部署 SHA: `c684ab0176a773267d45be0ae62aa1690aaef808`；备份 pre-1106v5-*.dump
- 实测: settle-accounts 三口径余额返回；GET /violations/:id → 200；/events/stream SSE 连通
- 在线配置: approver/meter_mgr 角色补绑 metering:service（shenpi01/biaowu01 生效）

# 185 部署记录 — r1109 v3（50ff1f5）

- 部署 SHA: `50ff1f55a555b58fc5741df47e6bd77132b795ac`；分支 HEAD 含迁移表名修正
- 备份: pre-1109-*.dump；迁移 `20261110000000_x123_l3`（属主执行：reader_zone.is_remote / install_application 外部回推+双合同+状态历史 / meter_reading.revision_log / meter_service_order 外派字段；修正 service_order→meter_service_order 表名）+ resolve 登记
- 冒烟: water-accounts/install-applications/reading-plans/prepayments/accounts 全 200；external-complete 端点可达（APPLY_NOT_FOUND=路由通）；ops-daily ?period= 200

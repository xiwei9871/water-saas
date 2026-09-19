# water-saas

小型水务公司 SaaS MVP —— 抄表/结算/计费/收费/日结/报表。
NestJS 模块化单体 + React + PostgreSQL（共享库 `tenant_id` + RLS 多租户隔离）。

## 结构

- `apps/api` — NestJS REST API（端口 3000）。租户隔离靠 PostgreSQL RLS：
  运行时连接用 `ws_app`（受限角色），迁移/种子用 owner 连接。
- `apps/web` — React 19 + Vite + antd v5 管理台（端口 5173，`/api` 前缀代理到 3000）。
- `packages/billing-core` — 纯函数计费引擎（阶梯/费项/结算），API 唯一依赖它的方式。
- `packages/types` — 前后端共享常量与枚举（web 使用）。

## 启动

```bash
docker compose up -d postgres          # postgres:15 + watersaas_test 库
cp .env.example apps/api/.env          # DATABASE_URL(ws_app)/MIGRATION_DATABASE_URL(owner)/JWT_SECRET
pnpm install
pnpm -C apps/api exec prisma migrate deploy   # owner 连接跑迁移
pnpm -C apps/api exec prisma db seed          # 种子租户 cd-water/xh-water（admin/admin123）
pnpm -C apps/api dev                        # API :3000
pnpm -C apps/web dev                        # Web :5173 → 登录 cd-water / admin / admin123
```

## 测试

```bash
pnpm -C packages/billing-core test   # 计费引擎单测
pnpm -C apps/api test                # API 单测
pnpm -C apps/api test:e2e            # 端到端（跑 watersaas_test，需先 migrate deploy 到该库）
pnpm -C apps/web lint / pnpm -C apps/api lint
pnpm -r build
```

## 约定速查

- 金额一律整数分（bigint，线上序列化为字符串），前端经 `fmtCent` 展示；
  数量/单价 decimal，前端发送字符串。
- 变更类 POST 携带 `Idempotency-Key`（每次打开表单生成新键）；天然幂等的
  端点（billing-run post/retry/discard、day-close）不带。
- 权限码共 11 个（`*/{customer,metering,billing,payment,iam}:{read,write}`、
  `report:read`），admin 角色恒等于 `*`。
- 红冲/换票全部追加式：原单不改状态，负额单/重开票为新行。
- 批量处理为同步语义（billing-run post 在同一请求内逐结算事务执行），
  无 worker/队列依赖；integration 端口是显式 stub。

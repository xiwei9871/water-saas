# Test Infrastructure Issues

非阻塞测试稳定性观察记录。业务功能修复不要与这些问题混在同一个 PR。

## TEST-INFRA-001: PostgreSQL / Prisma connection transient failures in e2e suite

**状态**: Open · 观察中（第三次出现时立项定位）

**现象**（2026-09-20, `feat/v0.2-feedback` 全量 e2e run）:

- `customer.e2e-spec.ts` beforeAll login → **502 Bad Gateway**
- `reconciliation.e2e-spec.ts` fixture onboard → **501 Not Implemented**
- 期间多条 `audit_log write failed PrismaClientUnknownRequestError: Response
  from the Engine was empty`
- 同一 commit 立即复跑：**258/258 全绿**，单文件运行也全绿

**既往观察**:

- v0.1.1 周期: settlement 套件 shutdown 时 `audit_log` 写入 engine-empty
  警告（不 fail）
- 即同一类 engine/连接瞬断至少已出现 2 次

**初步排除**:

- 非连接数耗尽：失败后立刻 `pg_stat_activity` 仅 1 连接，
  `max_connections=100`
- 非代码回归：同 commit 复跑通过

**第三次出现时的定位方向**:

- Prisma client pool size（`ws_app` 与测试 `owner` 双连接池）
- Postgres max_connections / PgBouncer 层
- vitest suite lifecycle：13 个 spec 顺序起 13 个 Nest app + Prisma
  engine，app shutdown 是否等 in-flight audit 事务
- parallel workers / worker 复用边界
- audit interceptor 的 fire-and-forget 写入是否加剧瞬断窗口

**参考命令**:

```bash
psql "$DATABASE_URL_TEST" -c \
  "SELECT count(*), state FROM pg_stat_activity WHERE datname='watersaas_test' GROUP BY state;"
```

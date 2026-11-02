#!/usr/bin/env bash
# G3 生产等价量级开账性能测试：造 N 户 → billing-run → 计时
# 用法: BASE=http://localhost:3000 N=1000 bash scripts/perf/billing-volume-test.sh
set -euo pipefail
B="${BASE:-http://localhost:3000}"; N="${N:-1000}"
T=$(curl -s $B/auth/login -X POST -H 'Content-Type: application/json' \
  -d '{"tenantCode":"t9-water","login":"t9-admin","password":"t9-pass"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")
A="Authorization: Bearer $T"; C="Content-Type: application/json"
PG="postgresql://postgres:postgres@localhost:5432/watersaas_test"
echo "== seed $N 户（直接 SQL 批量，绕过 API 速率）"
psql "$PG" <<'SQL'
-- 需要租户/主体存在；以 t9 fixture 为基
WITH t AS (SELECT '99999999-9999-4999-8999-999999999999'::uuid tid),
     c AS (SELECT id FROM customer, t WHERE tenant_id=tid AND name='RC1 王五' LIMIT 1)
SELECT count(*) FROM water_account WHERE tenant_id=(SELECT tid FROM t);
SQL
echo "== billing-run（period 202611）"
ST=$(date +%s%3N)
RUN=$(curl -s -X POST $B/billing-runs -H "$A" -H "$C" -d '{"period":"202611"}')
RID=$(echo "$RUN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
echo "  run=$RID"
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  S=$(curl -s $B/billing-runs/$RID -H "$A" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status'),d.get('stats',{}))" 2>/dev/null || echo "?")
  echo "  [$i] $S"
  echo "$S" | grep -q "POSTED\|DONE\|FAILED" && break
done
ET=$(date +%s%3N); echo "== elapsed $((ET-ST))ms for period run"

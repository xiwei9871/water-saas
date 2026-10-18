import type { Prisma } from '@prisma/client';

/**
 * Round-2 report §4/§9: operational documents carry their account's
 * display identity inline — accountNo + customerName are part of the
 * business record (settlement / bill / reconciliation / billing-run
 * bill), not gated on `customer:read`. Without this, any role lacking
 * customer:read degrades to raw uuids in every list (综合核查 saw
 * "10d9cc06… / —"). One batched lookup per response, no N+1.
 *
 * customerName stays null only when the row's account is somehow
 * missing (should not happen — FK'd); callers render '—' then.
 */
export async function embedAccountIdentity<
  T extends { waterAccountId?: string | null },
>(
  tx: Prisma.TransactionClient,
  tenantId: string,
  rows: T[],
): Promise<(T & { accountNo: string | null; customerName: string | null })[]> {
  if (rows.length === 0) return rows.map((r) => ({ ...r, accountNo: null, customerName: null }));
  const ids = [
    ...new Set(
      rows.map((r) => r.waterAccountId).filter((v): v is string => typeof v === 'string'),
    ),
  ];
  const accounts = ids.length
    ? await tx.waterAccount.findMany({
        where: { tenantId, id: { in: ids } },
        select: {
          id: true,
          accountNo: true,
          customer: { select: { name: true } },
        },
      })
    : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return rows.map((r) => {
    const acc = r.waterAccountId ? byId.get(r.waterAccountId) : undefined;
    return {
      ...r,
      accountNo: acc?.accountNo ?? null,
      customerName: acc?.customer.name ?? null,
    };
  });
}

/**
 * 10/8 报告 §2/§3: 结算户身份同样内嵌 —— 收款记录/日结等单据行直接
 * 携带 settleNo + settleName，无 customer:read 的角色不再看到裸 uuid。
 */
export async function embedSettleIdentity<
  T extends { settleAccountId?: string | null },
>(
  tx: Prisma.TransactionClient,
  tenantId: string,
  rows: T[],
): Promise<(T & { settleNo: string | null; settleName: string | null })[]> {
  if (rows.length === 0)
    return rows.map((r) => ({ ...r, settleNo: null, settleName: null }));
  const ids = [
    ...new Set(
      rows
        .map((r) => r.settleAccountId)
        .filter((v): v is string => typeof v === 'string'),
    ),
  ];
  const settles = ids.length
    ? await tx.settleAccount.findMany({
        where: { tenantId, id: { in: ids } },
        select: { id: true, settleNo: true, name: true },
      })
    : [];
  const byId = new Map(settles.map((s) => [s.id, s]));
  return rows.map((r) => {
    const s = r.settleAccountId ? byId.get(r.settleAccountId) : undefined;
    return {
      ...r,
      settleNo: s?.settleNo ?? null,
      settleName: s?.name ?? null,
    };
  });
}

/**
 * 10/8 报告 §2/§3: 员工身份内嵌 —— 收费员/抄表员等 staffId 字段批量
 * 解析为 '姓名（登录名）'，无 iam:read 的角色也能看到真实姓名。
 * `mapping`: 行内 staffId 字段 → 输出字段，如 {cashierId:'cashierName'}。
 */
export async function embedStaffNames<T extends object>(
  tx: Prisma.TransactionClient,
  tenantId: string,
  rows: T[],
  mapping: Record<string, string>,
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const fields = Object.keys(mapping);
  const ids = new Set<string>();
  for (const r of rows)
    for (const f of fields) {
      const v = (r as Record<string, unknown>)[f];
      if (typeof v === 'string') ids.add(v);
    }
  const staff = ids.size
    ? await tx.staff.findMany({
        where: { tenantId, id: { in: [...ids] } },
        select: { id: true, name: true, login: true },
      })
    : [];
  const byId = new Map(staff.map((s) => [s.id, s]));
  return rows.map((r) => {
    const out = { ...r } as Record<string, unknown>;
    for (const [f, outField] of Object.entries(mapping)) {
      const v = (r as Record<string, unknown>)[f];
      const s = typeof v === 'string' ? byId.get(v) : undefined;
      out[outField] = s ? `${s.name}（${s.login}）` : null;
    }
    return out as T;
  });
}

/**
 * 组织名内嵌 —— 抄表册/计划等行的 orgUnitId 批量解析为组织名称。
 */
export async function embedOrgNames<T extends object>(
  tx: Prisma.TransactionClient,
  tenantId: string,
  rows: T[],
  mapping: Record<string, string>,
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const fields = Object.keys(mapping);
  const ids = new Set<string>();
  for (const r of rows)
    for (const f of fields) {
      const v = (r as Record<string, unknown>)[f];
      if (typeof v === 'string') ids.add(v);
    }
  const orgs = ids.size
    ? await tx.orgUnit.findMany({
        where: { tenantId, id: { in: [...ids] } },
        select: { id: true, name: true },
      })
    : [];
  const byId = new Map(orgs.map((o) => [o.id, o]));
  return rows.map((r) => {
    const out = { ...r } as Record<string, unknown>;
    for (const [f, outField] of Object.entries(mapping)) {
      const v = (r as Record<string, unknown>)[f];
      const o = typeof v === 'string' ? byId.get(v) : undefined;
      out[outField] = o?.name ?? null;
    }
    return out as T;
  });
}

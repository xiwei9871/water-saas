import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { orgInScope, type TenantCtx } from './tenant-context.js';

const outOfScope = () => new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

/**
 * Account coverage rule (frozen E6/E7, E8 applies it tenant-wide):
 * WaterAccount → ReadingPlanItem → ReadingPlan → ReadingBook.orgUnitId.
 * EVERY covering book's org must sit inside the caller's orgScope; an
 * account with no plan coverage is off-book and returns permissively.
 */
export async function assertAccountScopeTx(
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  waterAccountId: string,
): Promise<void> {
  if (ctx.scope === 'ALL') return;
  const items = await tx.readingPlanItem.findMany({
    where: { tenantId: ctx.tenantId, waterAccountId },
    select: { planId: true },
  });
  if (items.length === 0) return;
  const plans = await tx.readingPlan.findMany({
    where: { tenantId: ctx.tenantId, id: { in: items.map((i) => i.planId) } },
    select: { bookId: true },
  });
  const books = await tx.readingBook.findMany({
    where: { tenantId: ctx.tenantId, id: { in: plans.map((p) => p.bookId) } },
    select: { orgUnitId: true },
  });
  for (const b of books) {
    if (!orgInScope(ctx, b.orgUnitId)) throw outOfScope();
  }
}

/**
 * Accounts that are out of scope for the caller (any covering book
 * outside orgScope). List-filter mirror of assertAccountScopeTx.
 */
export async function outOfScopeAccountIds(
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ water_account_id: string }[]>`
    SELECT DISTINCT rpi.water_account_id
    FROM reading_plan_item rpi
    JOIN reading_plan rp
      ON rp.tenant_id = rpi.tenant_id AND rp.id = rpi.plan_id
    JOIN reading_book rb
      ON rb.tenant_id = rpi.tenant_id AND rb.id = rp.book_id
    WHERE rpi.tenant_id = ${ctx.tenantId}::uuid
      AND rb.org_unit_id <> ALL(${ctx.orgScope}::uuid[])`;
  return rows.map((r) => r.water_account_id);
}

/**
 * SettleAccount strict scope (E6 freeze): a settle account is a write on
 * every bound book's account, so EVERY covering book across ALL linked
 * water accounts must be in scope. No linked coverage → permissive.
 */
export async function assertSettleScopeTx(
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  settleAccountId: string,
): Promise<void> {
  if (ctx.scope === 'ALL') return;
  const accounts = await tx.waterAccount.findMany({
    where: { tenantId: ctx.tenantId, settleAccountId },
    select: { id: true },
  });
  if (accounts.length === 0) return;
  const items = await tx.readingPlanItem.findMany({
    where: {
      tenantId: ctx.tenantId,
      waterAccountId: { in: accounts.map((a) => a.id) },
    },
    select: { planId: true },
  });
  if (items.length === 0) return;
  const plans = await tx.readingPlan.findMany({
    where: { tenantId: ctx.tenantId, id: { in: items.map((i) => i.planId) } },
    select: { bookId: true },
  });
  const books = await tx.readingBook.findMany({
    where: { tenantId: ctx.tenantId, id: { in: plans.map((p) => p.bookId) } },
    select: { orgUnitId: true },
  });
  for (const b of books) {
    if (!orgInScope(ctx, b.orgUnitId)) throw outOfScope();
  }
}

/**
 * Settle accounts hidden from the caller: ANY linked water account is
 * out of scope (strict E6 rule). List-filter mirror of
 * assertSettleScopeTx.
 */
export async function outOfScopeSettleAccountIds(
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
): Promise<string[]> {
  const bad = await outOfScopeAccountIds(tx, ctx);
  if (!bad.length) return [];
  const accounts = await tx.waterAccount.findMany({
    where: { tenantId: ctx.tenantId, id: { in: bad } },
    select: { settleAccountId: true },
  });
  return [...new Set(accounts.map((a) => a.settleAccountId))];
}

/**
 * E8 D2 read rule: a customer is visible iff it has no linked accounts
 * OR at least one linked account is in scope. Returns the ids of
 * customers hidden entirely (every linked account out-of-scope).
 */
export async function hiddenCustomerIds(
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
): Promise<string[]> {
  const bad = await outOfScopeAccountIds(tx, ctx);
  if (!bad.length) return [];
  const rows = await tx.$queryRaw<{ customer_id: string }[]>`
    SELECT wa.customer_id
    FROM water_account wa
    WHERE wa.tenant_id = ${ctx.tenantId}::uuid
    GROUP BY wa.customer_id
    HAVING bool_and(wa.id = ANY(${bad}::uuid[]))`;
  return rows.map((r) => r.customer_id);
}

/** Customer read: 403 iff every linked account is out of scope. */
export async function assertCustomerReadScopeTx(
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  customerId: string,
): Promise<void> {
  if (ctx.scope === 'ALL') return;
  const hidden = new Set(await hiddenCustomerIds(tx, ctx));
  if (hidden.has(customerId)) throw outOfScope();
}

/**
 * Customer write (E8 D2): stricter than read — ANY linked account out
 * of scope forbids mutating the shared master data.
 */
export async function assertCustomerWriteScopeTx(
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  customerId: string,
): Promise<void> {
  if (ctx.scope === 'ALL') return;
  const bad = new Set(await outOfScopeAccountIds(tx, ctx));
  if (!bad.size) return;
  const linked = await tx.waterAccount.findMany({
    where: { tenantId: ctx.tenantId, customerId },
    select: { id: true },
  });
  if (linked.some((a) => bad.has(a.id))) throw outOfScope();
}

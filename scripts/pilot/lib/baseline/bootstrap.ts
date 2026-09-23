/**
 * G3 bootstrap — pilot tenant infrastructure.
 * org_unit / staff / tenant_param have NO injectable service
 * (controller-private methods) → created here inside runAsTenant and
 * recorded as INFRA_BOOTSTRAP in the summary — never as anomaly
 * injection. fee-item / tariff go through real services (CALLER_MANAGED).
 */

import { apiImport } from '../api-import.ts';
import { apiRequire } from '../pg.ts';
import { keys } from '../keys.ts';
import type { Harness, TenantCtx } from '../harness.ts';
import { withTenantTx } from '../harness.ts';

type Tx = Parameters<Parameters<Harness['tenantPrisma']['runAsTenant']>[1]>[0];

const Pr = apiRequire('@prisma/client') as typeof import('@prisma/client');
const Dec = Pr.Prisma.Decimal;

export interface BootstrapResult {
  orgIds: string[]; // [company, ...branches]
  branchIds: string[];
  staffId: string;
  feeItemId: string;
  tariffPlanId: string;
  entities: { kind: string; id: string; key: string }[];
}

export async function bootstrapTenant(
  h: Harness,
  ctx: TenantCtx,
  seed: number,
  branches: number,
): Promise<BootstrapResult> {
  const entities: BootstrapResult['entities'] = [];

  // --- INFRA_BOOTSTRAP: orgs + staff + params (no domain service exists) ---
  const infra = await h.tenantPrisma.runAsTenant(ctx.tenantId, async (tx: Tx) => {
    const t = tx as {
      orgUnit: { create(a: unknown): Promise<{ id: string }> };
      staff: { create(a: unknown): Promise<{ id: string }> };
      tenantParam: { upsert(a: unknown): Promise<unknown> };
    };
    const company = await t.orgUnit.create({
      data: {
        tenantId: ctx.tenantId,
        parentId: null,
        name: `Pilot公司 P${String(seed).padStart(4, '0')}`,
        type: 'COMPANY',
      },
    });
    entities.push({ kind: 'org_unit', id: company.id, key: 'company' });
    const branchIds: string[] = [];
    for (let i = 0; i < branches; i++) {
      const b = await t.orgUnit.create({
        data: {
          tenantId: ctx.tenantId,
          parentId: company.id,
          name: keys.orgName(seed, i),
          type: 'BRANCH',
        },
      });
      branchIds.push(b.id);
      entities.push({ kind: 'org_unit', id: b.id, key: keys.orgCode(seed, i) });
    }
    // pilot admin/operator — real staff row required by payment/prepay/
    // day-close (STAFF_NOT_FOUND otherwise). No roles needed in-process.
    const staff = await t.staff.create({
      data: {
        tenantId: ctx.tenantId,
        orgUnitId: company.id,
        login: `pilot-admin-s${seed}`,
        passwordHash: 'pilot-no-login',
        name: `Pilot 操作员 S${seed}`,
        status: 'ACTIVE',
      },
    });
    entities.push({ kind: 'staff', id: staff.id, key: `pilot-admin-s${seed}` });
    // bill_due_days as a JSON NUMBER — pricing reads typeof === 'number'.
    await t.tenantParam.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: 'bill_due_days' } },
      create: {
        tenantId: ctx.tenantId,
        key: 'bill_due_days',
        value: 45,
      },
      update: { value: 45 },
    });
    return { companyId: company.id, branchIds, staffId: staff.id };
  });

  const ctxAll = { ...ctx, staffId: infra.staffId };

  // --- DOMAIN_FLOW: fee item + tariff plan (caller-managed services) ---
  const { FeeItemService } = await apiImport<{ FeeItemService: unknown }>(
    'modules/billing/fee-item.service',
  );
  const { TariffPlanService } = await apiImport<{ TariffPlanService: unknown }>(
    'modules/billing/tariff-plan.service',
  );
  const feeSvc = h.get<{
    createTx(tx: Tx, c: TenantCtx, b: unknown): Promise<{ id: string }>;
  }>(FeeItemService);
  const tariffSvc = h.get<{
    createTx(tx: Tx, c: TenantCtx, b: unknown): Promise<{ id: string }>;
    activateTx(tx: Tx, c: TenantCtx, id: string, req: unknown): Promise<unknown>;
  }>(TariffPlanService);

  const feeItemId = await withTenantTx(
    h,
    'FeeItemService.createTx',
    ctx.tenantId,
    (tx) =>
      feeSvc.createTx(tx as Tx, ctxAll, {
        code: `WATER-S${seed}`,
        name: 'Pilot 水费',
        calcType: 'PER_QTY',
      }).then((r) => r.id),
  );
  entities.push({ kind: 'fee_item', id: feeItemId, key: `WATER-S${seed}` });

  const tariffPlanId = await withTenantTx(
    h,
    'TariffPlanService.createTx',
    ctx.tenantId,
    async (tx) => {
      const plan = await tariffSvc.createTx(tx as Tx, ctxAll, {
        code: `PILOT-RES-S${seed}`,
        name: 'Pilot 居民水价',
        usageCategory: 'RES_METERED',
        effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
        tiers: [
          {
            feeItemId,
            tierNo: 1,
            fromQty: new Dec(0),
            toQty: null,
            unitPrice: new Dec('3.0'),
          },
        ],
      });
      await tariffSvc.activateTx(tx as Tx, ctxAll, plan.id, {});
      return plan.id;
    },
  );
  entities.push({ kind: 'tariff_plan', id: tariffPlanId, key: `PILOT-RES-S${seed}` });

  return {
    orgIds: [infra.companyId, ...infra.branchIds],
    branchIds: infra.branchIds,
    staffId: infra.staffId,
    feeItemId,
    tariffPlanId,
    entities,
  };
}

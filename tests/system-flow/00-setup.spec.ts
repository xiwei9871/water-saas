import { test, expect, evidence } from './helpers/test';
import { load, save, record } from './helpers/state';
import { db, bcrypt } from './helpers/db';
import { login, ready, STAFF_PASSWORD } from './helpers/ui';

/**
 * S00 — deterministic bootstrap for the sf-water tenant. Everything here
 * is an allowed fixture: tenant, org tree, roles, staff users, fee items,
 * estimate rule, tenant params and ACTIVE tariff plans. No operator
 * journey happens in this file — J1 onward is pure UI.
 */
test('S00 tenant + orgs + roles + staff + tariff fixtures', async ({ page }, info) => {
  const s = load();
  const hash = await bcrypt.hash(STAFF_PASSWORD, 10);

  await db(async (p) => {
    const tenant = await p.tenant.upsert({
      where: { code: 'sf-water' },
      update: {},
      create: { code: 'sf-water', name: '系统流演示水务', status: 'ACTIVE', params: {} },
    });
    s.tenantId = tenant.id;

    const org = async (name: string, type: 'COMPANY' | 'BRANCH', parentId: string | null) =>
      (await p.orgUnit.findFirst({ where: { tenantId: tenant.id, name, type } })) ??
      (await p.orgUnit.create({ data: { tenantId: tenant.id, name, type, parentId } }));

    const company = await org('系统流演示水务公司', 'COMPANY', null);
    s.companyOrgId = company.id;
    s.branches = [];
    for (const name of ['城东营业所', '城西营业所', '城南营业所']) {
      s.branches.push(await org(name, 'BRANCH', company.id));
    }

    const roleDefs: [string, string, 'ALL' | 'ORG_SUBTREE'][] = [
      ['admin', '系统管理员', 'ALL'],
      ['reader', '抄表员', 'ORG_SUBTREE'],
      ['reviewer', '复核员', 'ORG_SUBTREE'],
      ['cashier', '收费员', 'ORG_SUBTREE'],
      ['branchop', '营业所操作员', 'ORG_SUBTREE'],
    ];
    const roleIds: Record<string, string> = {};
    for (const [code, name, dataScope] of roleDefs) {
      const role = await p.role.upsert({
        where: { tenantId_code: { tenantId: tenant.id, code } },
        update: { name, dataScope },
        create: { tenantId: tenant.id, code, name, dataScope },
      });
      roleIds[code] = role.id;
    }

    const permCodes = [
      'customer:read', 'customer:write', 'metering:read', 'metering:write',
      'metering:qc', 'metering:remote:manage', 'billing:read', 'billing:write',
      'payment:read', 'payment:write', 'prepayment:reverse', 'iam:read',
      'iam:write', 'report:read', 'exception:read', 'exception:manage',
    ];
    const perms: Record<string, string> = {};
    for (const code of permCodes) {
      perms[code] = (await p.permission.upsert({
        where: { tenantId_code: { tenantId: tenant.id, code } },
        update: {},
        create: { tenantId: tenant.id, code, type: 'ACTION' },
      })).id;
    }
    const bind = async (roleCode: string, codes: string[]) => {
      for (const code of codes) {
        await p.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: roleIds[roleCode], permissionId: perms[code] } },
          update: { tenantId: tenant.id },
          create: { tenantId: tenant.id, roleId: roleIds[roleCode], permissionId: perms[code] },
        });
      }
    };
    await bind('reader', ['customer:read', 'metering:read', 'metering:write', 'exception:read']);
    await bind('reviewer', ['metering:qc', 'metering:read', 'billing:read', 'report:read', 'exception:read', 'exception:manage']);
    await bind('cashier', ['customer:read', 'billing:read', 'payment:read', 'payment:write', 'exception:read']);
    await bind('branchop', ['customer:read', 'metering:read', 'metering:write']);

    // staff: admin on the company; scoped staff on branch A (城西 B for
    // the cross-branch negative case is reached via an account sitting in
    // branch B's book).
    const staffFixtures: [string, string, string, string][] = [
      ['admin', '管理员', 'admin', s.companyOrgId],
      ['sf-reader', '抄表员小赵', 'reader', s.branches[0].id],
      ['sf-reviewer', '复核员小钱', 'reviewer', s.companyOrgId],
      ['sf-cashier1', '收费员小孙', 'cashier', s.companyOrgId],
      ['sf-cashier2', '收费员小李', 'cashier', s.companyOrgId],
      ['sf-branchop', '城东操作员', 'branchop', s.branches[0].id],
    ];
    s.roles = {};
    for (const [loginName, name, roleCode, orgId] of staffFixtures) {
      const staff = await p.staff.upsert({
        where: { tenantId_login: { tenantId: tenant.id, login: loginName } },
        update: { passwordHash: hash, orgUnitId: orgId, status: 'ACTIVE' },
        create: { tenantId: tenant.id, orgUnitId: orgId, login: loginName, name, passwordHash: hash, status: 'ACTIVE' },
      });
      await p.staffRole.upsert({
        where: { staffId_roleId: { staffId: staff.id, roleId: roleIds[roleCode] } },
        update: { tenantId: tenant.id },
        create: { tenantId: tenant.id, staffId: staff.id, roleId: roleIds[roleCode] },
      });
      s.roles[roleCode === 'admin' ? 'admin' : loginName] = { id: staff.id, login: loginName, name };
    }

    for (const f of [
      { code: 'WATER', name: '水费', calcType: 'PER_QTY' },
      { code: 'SEWAGE', name: '污水费', calcType: 'PER_QTY' },
    ]) {
      await p.feeItem.upsert({
        where: { tenantId_code: { tenantId: tenant.id, code: f.code } },
        update: {},
        create: { tenantId: tenant.id, ...f },
      });
    }
    await p.estimateRule.upsert({
      where: { tenantId_method: { tenantId: tenant.id, method: 'AUTO_AVG3' } },
      update: { enabled: true },
      create: { tenantId: tenant.id, method: 'AUTO_AVG3', params: { window: 3 }, enabled: true },
    });
    for (const [key, value] of Object.entries({
      max_consecutive_estimates: 3,
      reconcile_alloc_policy: 'PROPORTIONAL_TO_SETTLED',
      negative_usage_policy: 'CLAMP_REVIEW',
    })) {
      await p.tenantParam.upsert({
        where: { tenantId_key: { tenantId: tenant.id, key } },
        update: { value: value as never },
        create: { tenantId: tenant.id, key, value: value as never },
      });
    }

    // Tariff fixture (immutable config): two ACTIVE plans, flat PER_QTY
    // WATER so every bill's cent amount is usage × unitPrice exactly.
    const water = await p.feeItem.findUniqueOrThrow({
      where: { tenantId_code: { tenantId: tenant.id, code: 'WATER' } },
    });
    const plans: [string, string, string][] = [
      ['SF-RES', '居民水价', 'RES_METERED'],
      ['SF-SHARED', '合表水价', 'RES_SHARED'],
      ['SF-COM', '商业水价', 'NON_RES'],
    ];
    const prices = { 'SF-RES': '3', 'SF-SHARED': '3', 'SF-COM': '5' };
    s.tariffs = {};
    for (const [code, name, category] of plans) {
      let plan = await p.tariffPlan.findFirst({ where: { tenantId: tenant.id, code } });
      if (!plan) {
        plan = await p.tariffPlan.create({
          data: {
            tenantId: tenant.id, code, name, usageCategory: category,
            status: 'ACTIVE', effectiveFrom: new Date('2026-01-01'),
          },
        });
        await p.tariffTier.create({
          data: {
            tenantId: tenant.id, tariffPlanId: plan.id, feeItemId: water.id,
            tierNo: 1, fromQty: 0, toQty: null, unitPrice: prices[code as 'SF-RES'],
          },
        });
      }
      s.tariffs[category] = { id: plan.id, category, unitPrice: prices[code as keyof typeof prices] };
    }
  });
  save(s);

  await login(page);
  const me = await page.evaluate(async () => {
    const r = await fetch('/api/auth/me', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('water-saas.accessToken') },
    });
    return r.json();
  });
  expect(JSON.stringify(me)).toContain(s.tenantId);
  s.stages.setup = true;
  save(s);
  await evidence(page, info, 's00-setup', { tenantId: s.tenantId, branches: s.branches, roles: s.roles });
});

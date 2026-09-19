import { test, expect } from './helpers/console';
import { login, ready } from './helpers/auth';
import { roleFixtures } from './helpers/fixture';
import { evidence } from './helpers/ui';

test.beforeAll(async () => { await roleFixtures(); });
const roles = {
  reader: { visible: ['客户管理', '抄表管理'], hidden: ['收费管理', '系统管理', '计费管理', '报表'], denied: ['/system/staff', '/payment/counter', '/billing/tariffs', '/customer/onboard'], apis: ['/iam/staff', '/payments'], readOnly: '/customer/customers', absent: '新建客户' },
  cashier: { visible: ['客户管理', '计费管理', '收费管理'], hidden: ['抄表管理', '系统管理', '报表'], denied: ['/system/staff', '/metering/readings', '/customer/onboard'], apis: ['/iam/staff', '/meter-readings'], readOnly: '/billing/tariffs', absent: '新建资费方案' },
  reviewer: { visible: ['抄表管理', '计费管理', '报表'], hidden: ['客户管理', '收费管理', '系统管理'], denied: ['/system/staff', '/payment/counter', '/customer/onboard'], apis: ['/iam/staff', '/payments'], readOnly: '/metering/readings', absent: '通过' },
};
for (const [role, config] of Object.entries(roles)) {
  test(`J02 J03 J04 ${role} menus and read-only controls`, async ({ page }, info) => {
    await login(page, 'uat-' + role, 'uat12345');
    for (const label of config.visible) await expect(page.getByRole('menuitem', { name: new RegExp(label) })).toBeVisible();
    for (const label of config.hidden) await expect(page.getByRole('menuitem', { name: new RegExp(label) })).toHaveCount(0);
    await page.goto(config.readOnly); await ready(page);
    await expect(page.getByRole('main').getByRole('button', { name: new RegExp(config.absent) })).toHaveCount(0);
    await evidence(page, info, 'permissions-' + role);
  });
  test(`J06 ${role} direct URL denied and backend fail closed via browser proxy`, async ({ page, audit }, info) => {
    await login(page, 'uat-' + role, 'uat12345');
    for (const path of config.denied) {
      await page.goto(path); await ready(page);
      await expect(page).toHaveURL('http://127.0.0.1:4173/');
      await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
    }
    for (const path of config.apis) {
      audit.allow('/api' + path, 403, 'GET');
      const denied = await page.evaluate(async path => {
        const result = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + localStorage.getItem('water-saas.accessToken') } });
        return { status: result.status, body: await result.json() };
      }, path);
      expect(denied.status).toBe(403);
      await info.attach('denied-' + path.replaceAll('/', '-'), { body: JSON.stringify(denied), contentType: 'application/json' });
    }
    // Attempt an actual unauthorized write; seeded role must be rejected before payload validation.
    const writePath = role === 'reader' ? '/tariff-plans' : role === 'cashier' ? '/meter-readings' : '/payments';
    audit.allow('/api' + writePath, 403, 'POST');
    const write = await page.evaluate(async path => {
      const r = await fetch('/api' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('water-saas.accessToken'), 'Content-Type': 'application/json' }, body: '{}' });
      return { status: r.status, body: await r.json() };
    }, writePath);
    expect(write.status).toBe(403);
    await info.attach('denied-write', { body: JSON.stringify(write), contentType: 'application/json' });
  });
}
test('J01 admin sees all menu groups', async ({ page }) => {
  await login(page);
  for (const label of ['客户管理', '抄表管理', '结算补差', '计费管理', '收费管理', '报表', '系统管理'])
    await expect(page.getByRole('menuitem', { name: new RegExp(label) })).toBeVisible();
});

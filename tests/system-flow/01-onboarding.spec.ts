import { test, expect, evidence } from './helpers/test';
import { load, save } from './helpers/state';
import { db } from './helpers/db';
import { login, personLabel } from './helpers/ui';
import { onboard, type PersonSpec } from './helpers/onboard';
import { row } from '../uat/helpers/ui';

/**
 * J1 — customer → WaterAccount → meter → ACTIVE installation, all through
 * the real 立户向导 UI. ~20 accounts: normal residential across branches,
 * one shared-settlement pair, one non-res, one monitoring meter.
 * Read-only DB assertions: exactly one WaterAccount + one ACTIVE
 * installation per account, settle link correct.
 */
const PEOPLE: PersonSpec[] = [
  // 城东 book A accounts
  ...Array.from({ length: 8 }, (_, i) => ({
    key: `SF-A-${String(i + 1).padStart(3, '0')}`,
    category: 'RES_METERED' as const,
    addr: `城东街道${i + 1}号`,
    initialReading: String(i * 5),
  })),
  // 城西 book B accounts (cross-branch scope case)
  ...Array.from({ length: 4 }, (_, i) => ({
    key: `SF-B-${String(i + 1).padStart(3, '0')}`,
    category: 'RES_METERED' as const,
    addr: `城西街道${i + 1}号`,
    initialReading: String(i * 7),
  })),
  // 城南 book C accounts
  ...Array.from({ length: 4 }, (_, i) => ({
    key: `SF-C-${String(i + 1).padStart(3, '0')}`,
    category: 'RES_METERED' as const,
    addr: `城南街道${i + 1}号`,
    initialReading: String(i * 3),
  })),
  // shared settlement pair (SF-S-002 settles onto SF-S-001's account)
  { key: 'SF-S-001', category: 'RES_SHARED', addr: '合表小区1栋101', initialReading: '0' },
  { key: 'SF-S-002', category: 'RES_SHARED', addr: '合表小区1栋102', initialReading: '0', sharedWith: 'SF-S-001' },
  // non-res commercial
  { key: 'SF-N-001', category: 'NON_RES', addr: '商业街8号商铺', initialReading: '0' },
  // monitoring meter — non-billable
  { key: 'SF-M-001', category: 'MONITORING', addr: '管网监测点1', initialReading: '0' },
  // deliberately bookless — deterministic NO_BOOK anomaly fixture (J7)
  { key: 'SF-X-001', category: 'RES_METERED', addr: '城东街道99号', initialReading: '0' },
];

test.describe.configure({ mode: 'serial' });

test('J1 onboard all accounts via 立户向导', async ({ page }, info) => {
  const s = load();
  await login(page);

  for (const spec of PEOPLE) {
    if (s.people.find((p) => p.key === spec.key)) continue; // checkpoint resume
    const person = await onboard(page, spec, s.people);
    s.people.push(person);
    save(s); // checkpoint immediately — never replay an ambiguous create
  }

  // Result-panel assertions live inside onboard() ('立户完成' + captured
  // response); on a resumed run the panel is already gone, so verify via
  // the water-accounts list instead.
  const last = s.people[s.people.length - 1];
  await page.goto(`/customer/water-accounts?accountNo=${last.waterAccount.accountNo}`);
  await expect(row(page, last.waterAccount.accountNo)).toBeVisible();
  await evidence(page, info, 'j1-onboard-result', last);

  // 360° opens from the water-accounts list (use a normal account).
  const normal = s.people.find((p) => p.key === 'SF-N-001');
  await page.goto(`/customer/water-accounts?accountNo=${normal.waterAccount.accountNo}`);
  await row(page, normal.waterAccount.accountNo).getByRole('button', { name: '360°' }).click();
  await expect(page.getByRole('tab', { name: '概览' })).toBeVisible();
  await expect(page.getByText(normal.waterAccount.accountNo).first()).toBeVisible();
  await evidence(page, info, 'j1-360-overview');
  await page.keyboard.press('Escape');

  // read-only DB truth: each account → 1 water_account, 1 ACTIVE install,
  // settle link matches the returned pair.
  await db(async (p) => {
    for (const person of s.people) {
      const accts = await p.waterAccount.findMany({
        where: { tenantId: s.tenantId, accountNo: person.key },
      });
      expect(accts).toHaveLength(1);
      const installs = await p.meterInstallation.findMany({
        where: { tenantId: s.tenantId, waterAccountId: person.waterAccount.id },
      });
      // rerun-safe: J6 closes SF-D-001 (0 ACTIVE); everyone else keeps
      // exactly one ACTIVE installation
      const wa = await p.waterAccount.findUniqueOrThrow({ where: { id: accts[0].id } });
      expect(installs.filter((i: any) => i.status === 'ACTIVE'))
        .toHaveLength(wa.status === 'CLOSED' ? 0 : 1);
      expect(person.waterAccount.settleAccountId).toBe(person.settleAccount.id);
      expect(person.installation.meterId).toBe(person.meter.id);
    }
    // shared settle: SF-S-001 and SF-S-002 share one settle account
    const s1 = s.people.find((p) => p.key === 'SF-S-001');
    const s2 = s.people.find((p) => p.key === 'SF-S-002');
    expect(s2.waterAccount.settleAccountId).toBe(s1.settleAccount.id);
  });
  s.stages.j1 = true;
  save(s);
});

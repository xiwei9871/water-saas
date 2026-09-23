import { expect, type Page } from '@playwright/test';
import { choose, date, personLabel, response } from './ui';

export interface PersonSpec {
  key: string;            // deterministic key, also embedded in names/numbers
  category: 'RES_METERED' | 'RES_SHARED' | 'NON_RES' | 'SPECIAL' | 'MONITORING';
  addr: string;
  initialReading: string;
  /** onboard onto an earlier person's settle account (shared-settlement case) */
  sharedWith?: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  RES_METERED: '居民（户表）',
  RES_SHARED: '居民（非户表）',
  NON_RES: '非居民',
  SPECIAL: '特种',
  MONITORING: '监控表',
};

/**
 * Drive the real 立户向导 end to end. Returns the OnboardResult payload
 * (customer/settleAccount/waterAccount/meter/installation).
 */
export async function onboard(page: Page, spec: PersonSpec, people: any[]): Promise<any> {
  await page.goto('/customer/onboard');
  await expect(page.getByText('立户向导').first()).toBeVisible();

  await choose(page, page.getByText('选择用水类别', { exact: true }), CATEGORY_LABEL[spec.category]);
  const monitoring = spec.category === 'MONITORING';

  if (!monitoring) {
    // step 0 — new customer
    await page.getByLabel('客户名称').fill(`流试用户${spec.key}`);
    await page.getByLabel('证件类型').fill('身份证');
    await page.getByLabel('证件号码').fill(`5101001990${spec.key.replace(/\D/g, '').padStart(4, '0')}1234`);
    await page.getByLabel('联系电话').fill(`138${spec.key.replace(/\D/g, '').padStart(8, '0')}`);
    await page.getByLabel('联系地址').fill(spec.addr);
    await page.getByRole('button', { name: /下\s*一\s*步/ }).click();

    // step 1 — settle account
    if (spec.sharedWith) {
      await page.getByText('选择已有结算户', { exact: true }).click();
      const owner = people.find((p) => p.key === spec.sharedWith);
      await choose(page, page.getByText('搜索结算户名称', { exact: true }), `${owner.settleAccount.name}（${owner.settleAccount.settleNo}）`, owner.settleAccount.name);
    }
    await page.getByRole('button', { name: /下\s*一\s*步/ }).click();
  }

  // step 2 — water account
  await page.getByLabel('用水地址').fill(spec.addr);
  await page.getByLabel('户号').fill(spec.key);
  await date(page.getByLabel('开户日期'), '2026-06-01');
  await page.getByRole('button', { name: /下\s*一\s*步/ }).click();

  // step 3 — meter + installation
  await page.getByLabel('表号').fill(`M-${spec.key}`);
  await page.getByLabel('口径').fill('DN15');
  await page.getByLabel('最大读数（表位）').fill('99999');
  await page.getByLabel('装表初始读数').fill(spec.initialReading);
  await date(page.getByLabel('装表日期'), '2026-06-01');

  const result = await response(page, '/water-accounts/onboard', async () => {
    await page.getByRole('button', { name: /提\s*交\s*立\s*户/ }).click();
  });
  await expect(page.getByText('立户完成').first()).toBeVisible();
  return { key: spec.key, addr: spec.addr, ...result };
}

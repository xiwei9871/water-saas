import { expect, test, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers/auth';

/**
 * 抄表工作台 H5（/m/reading）线上自查：
 * 我的计划 → 更新数据 → 顺序查表（录读数/无法抄见/跳过）→ 任务清单 → 进度。
 * 会真实写入抄表记录（消耗待抄项），与既有 e10 演示数据口径一致。
 */

test.use({ viewport: { width: 390, height: 844 } });

/** 1x1 白色 JPEG —— 供「拍照」强制校验场景用。 */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhADEAAAAT8n/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCcf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQYBAQABVP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hH//Z',
  'base64',
);

async function api(page: Page, method: 'get' | 'post', path: string, data?: unknown) {
  const base = new URL(page.url()).origin;
  const token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken'));
  return page.request.fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data,
  });
}

/** 找一个有待抄项且对我可见的计划（readerId 为空或指派给我）。 */
async function pickPlanWithPending(page: Page) {
  const me = await (await api(page, 'get', '/auth/me')).json();
  const plans = (await (await api(page, 'get', '/reading-plans?take=200')).json()) as
    | { items?: { id: string; status: string; readerId?: string | null; period: string }[] }
    | { id: string; status: string; readerId?: string | null; period: string }[];
  const rows = Array.isArray(plans) ? plans : (plans.items ?? []);
  const candidates = rows
    .filter(
      (p) =>
        (p.status === 'OPEN' || p.status === 'IN_PROGRESS') &&
        (!p.readerId || p.readerId === me.id),
    )
    .sort((a, b) => b.period.localeCompare(a.period));
  for (const p of candidates) {
    const res = await api(page, 'get', `/reading-plans/${p.id}/items?status=PENDING&take=200`);
    const body = await res.json();
    const items = (Array.isArray(body) ? body : (body.items ?? [])) as {
      id: string;
      waterAccountId: string;
      accountNo?: string | null;
      prevReadingValue?: string | null;
    }[];
    if (items.length > 0) return { plan: p, items };
  }
  return null;
}

test.describe('抄表工作台 H5', () => {
  test('选计划→顺序录读数→无法抄见→进度推进', async ({ page }) => {
    await loginAsAdmin(page);
    const picked = await pickPlanWithPending(page);
    test.skip(!picked, '无可见的待抄计划项（需先造 OPEN/IN_PROGRESS 计划）');
    const { plan, items } = picked!;
    const item = items[0];

    await page.goto('/m/reading');
    await expect(page.getByText('抄表工作台')).toBeVisible();

    // 计划下拉只应出现 OPEN/IN_PROGRESS 且未指派给他人的计划
    await page.getByRole('combobox').click();
    await page
      .locator('.ant-select-item')
      .filter({ hasText: plan.period })
      .first()
      .click();

    // 新界面要素：更新数据/抄表统计/上传按钮 + 任务清单恒在
    await expect(page.getByRole('button', { name: /更新数据/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /抄表统计/ })).toBeVisible();
    await expect(page.getByText('任务清单（点击定位）')).toBeVisible();
    await expect(page.getByPlaceholder('输入本期读数')).toBeVisible();
    await expect(page.getByRole('button', { name: /跳\s*过/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /拍照/ }).first()).toBeVisible();
    if (item.accountNo) {
      await expect(page.getByText(item.accountNo).first()).toBeVisible();
    }

    // 拍照（监控表/非户表必拍，户表选填）——统一先拍，顺带覆盖照片链路
    await page.locator('input[type="file"]').setInputFiles({
      name: 'site.jpg',
      mimeType: 'image/jpeg',
      buffer: TINY_JPEG,
    });
    await expect(page.getByRole('button', { name: /已拍照/ })).toBeVisible();

    // 录入读数：上期止度+5（无上期则 5），走 ACTUAL
    const prev = item.prevReadingValue ? Number(item.prevReadingValue) : 0;
    const value = prev + 5;
    await page.getByPlaceholder('输入本期读数').fill(String(value));
    const [postRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/meter-readings') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /提交读数/ }).click(),
    ]);
    expect(postRes.status(), JSON.stringify(await postRes.json().catch(() => null))).toBe(201);
    await expect(page.getByText(/已抄录|复核任务/).first()).toBeVisible();

    // 已抄户在清单中标记「已抄 NNNN」（切「已抄」过滤可见）
    if (item.accountNo) {
      await page.locator('.ant-segmented-item', { hasText: '已抄' }).click();
      await expect(page.getByText(item.accountNo).first()).toBeVisible();
      await page.locator('.ant-segmented-item', { hasText: '待抄' }).click();
    }

    // 第二项走「无法抄见」分支（若仍有待抄项）——非正常查表必须拍照
    const rest = await api(page, 'get', `/reading-plans/${plan.id}/items?status=PENDING&take=200`);
    const restBody = await rest.json();
    const remaining = (Array.isArray(restBody) ? restBody : (restBody.items ?? [])) as {
      id: string;
    }[];
    if (remaining.length > 0) {
      // 先拍照（隐藏 file input 直接 setInputFiles 触发压缩流）
      await page.locator('input[type="file"]').setInputFiles({
        name: 'site.jpg',
        mimeType: 'image/jpeg',
        buffer: TINY_JPEG,
      });
      await expect(page.getByRole('button', { name: /已拍照/ })).toBeVisible();
      await page.getByRole('button', { name: /无法抄见/ }).click();
      const modal = page.locator('.ant-modal');
      await modal.locator('.ant-select').click();
      await page
        .locator('.ant-select-item')
        .filter({ hasText: '占压无法查看' })
        .first()
        .click();
      const [noReadRes] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes('/meter-readings') && r.request().method() === 'POST',
        ),
        modal.getByRole('button', { name: /提\s*交/ }).click(),
      ]);
      expect(noReadRes.status(), JSON.stringify(await noReadRes.json().catch(() => null))).toBe(201);
    }

    // 进度接口复核：至少记下一笔 READ
    const prog = await (await api(page, 'get', `/reading-plans/${plan.id}/progress`)).json();
    expect(prog.READ).toBeGreaterThanOrEqual(1);
  });
});

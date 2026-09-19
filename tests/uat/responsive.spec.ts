import { test, expect } from './helpers/console';
import { login, ready } from './helpers/auth';
import { layoutRoutes } from './helpers/routes';
import { dimensions, evidence } from './helpers/ui';
for (const [width, height] of [[1280, 800], [1024, 768]]) {
  for (const [, path, title] of layoutRoutes) test(`B10 ${width} ${path}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await login(page); await page.goto(path); await ready(page);
    await expect.soft(page.getByRole('main').getByText(title, { exact: true }).first()).toBeVisible();
    const size = await dimensions(page);
    await evidence(page, info, 'layout', size);
    expect(size.scrollWidth, 'No body horizontal overflow; table internal scroll is acceptable').toBeLessThanOrEqual(size.width + 2);
  });
}

for (const [width, height] of [[1280, 800], [1024, 768]]) {
  for (const [path, open, confirm] of [
    ['/metering/plans', '生成计划', '生成'],
    ['/settlement/list', '生成结算', '生成'],
    ['/billing/tariffs', '新建资费方案', '保存'],
    ['/payment/day-close', '执行日结', '日结'],
  ]) test(`B10 modal ${width} ${path}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await login(page); await page.goto(path); await ready(page);
    await page.getByRole('button', { name: open }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const save = dialog.getByRole('button', { name: new RegExp(confirm.split('').join('\\s*') + '$') });
    await expect.poll(() => dialog.evaluate(el => getComputedStyle(el).transform)).toBe('none');
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    const box = await dialog.boundingBox();
    await evidence(page, info, 'modal-layout', box);
    expect(box!.x).toBeGreaterThanOrEqual(-2);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 2);
    // A tall modal may scroll vertically, but its final action must remain reachable.
  });
}

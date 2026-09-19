# Playwright UAT — v0.1.1

本目录是针对 `v0.1.1-mvp` 的前端 UAT 自动化，不属于产品运行时。

## 前提

在项目根目录已经运行：

- PostgreSQL fresh UAT DB（已 migrate + seed）
- API production mode: `http://127.0.0.1:3000`
- Web production preview: `http://127.0.0.1:4173`

默认登录：
- tenant: `cd-water`
- login: `admin`
- password: `admin123`

均可用环境变量覆盖。

## 安装与运行

```bash
cd uat/playwright
npm install
npx playwright install chromium

UAT_BASE_URL=http://127.0.0.1:4173 \
UAT_TENANT=cd-water \
UAT_LOGIN=admin \
UAT_PASSWORD=admin123 \
npm test
```

带浏览器观察：

```bash
npm run test:headed
```

查看 HTML 报告：

```bash
npm run report
```

## 测试原则

- 测试串行运行，避免共享 UAT DB 引起假阳性。
- 业务 fixture 尽量通过真实 API 创建；用户可见操作尽量通过页面执行。
- 失败自动保留 screenshot / trace / video。
- Playwright 失败不自动等价为产品 bug：先区分 selector/harness 问题、测试数据问题和真实产品缺陷。
- 不在 `main` 上直接修 UAT 发现的问题；先记录到 UAT findings/backlog。

# v0.1.1 Frontend UAT Report

## Executive Summary

Build: v0.1.1-mvp

Baseline SHA: `503bbf0c0ec8f0ec23a3db4c5d7c8c0ca1a679d0`

Tested branch HEAD before UAT changes: `fe19bb41b19a96cbcc72ece469fa877a15e88280`

Branch: `uat/playwright-v0.1.1`

Browser: Chromium 153.0.8010.12 / Playwright 1.63.0

Environment: `water_uat_v011`

Date: 2026-09-19 (Asia/Shanghai)

Automated: 65

Passed: 63

Failed: 2

Blocked: 0

Flaky: 0

P0: 0

P1: 0

P2: 4

P3: 1

本轮是实际浏览器 UAT，未修复或修改产品代码。首次 `git fetch / checkout / pull --ff-only / status` 确认工作区干净，`git merge-base --is-ancestor v0.1.1-mvp HEAD` 成功。产品目录相对于发布标签无差异。

数据库最初不存在，由本会话创建。预跑后仅重建本会话的 `water_uat_v011`，显式传入 runtime `ws_app` URL 与 owner `MIGRATION_DATABASE_URL`，执行当前版本全部 7 个 migration 和 seed；确认 `cd-water`、`xh-water`。未使用已有 smoke/RC 数据库。

`pnpm build` 成功。API 使用 `NODE_ENV=production`、独立随机 JWT secret、`node dist/main`、3000 端口；Web 使用 production build 的 `vite preview --host 127.0.0.1 --port 4173 --strictPort`。全部浏览器 fetch/XHR 经 `http://127.0.0.1:4173/api/*`，无 mock、无直连 3000。SQL 仅用于角色 fixture、干净账期选择和重复单据核对；NO_READ 独立案例的前置数据使用浏览器 `/api` fixture。主链所有创建、状态变更均通过 UI。

统计单位为独立 Playwright test，不把重试重复计数；Happy Path 是一个包含 12 个命名步骤的串行 test。未覆盖清单项与因失败被阻塞的自动化测试分别列示，未测试不算 PASS。布局/文案发现包含人工检查截图，故 finding 数不等于 failed test 数。

### Reproduction and evidence

- 完整命令：`pnpm exec playwright test`；仅 Chromium，1 worker，retries=1。
- 配置：1440×900 主场景，1280×800 / 1024×768 布局；失败保留 screenshot、trace、video。
- HTML：[artifacts/uat/html-report/index.html](../artifacts/uat/html-report/index.html)
- 原始结果：[results.json](../artifacts/uat/results.json)、[run log](../artifacts/uat/final-run.log)
- 每次尝试：[attempt-summary.json](../artifacts/uat/attempt-summary.json)
- 可检索证据：[evidence-index.json](../artifacts/uat/evidence-index.json)、[network-summary.json](../artifacts/uat/network-summary.json)
- 脚本说明：[tests/uat/README.md](../tests/uat/README.md)；提取结果：`python3 tests/uat/summarize.py`。
- 大型证据和本地 JWT 均在已 gitignore 的 `artifacts/uat/`，不提交；本地 HTML 的依赖资源保留完整。

### First attempt and retry

最终完整运行时间：2026-09-19 18:54:10—18:56:37，耗时146.95秒。

| Test | First attempt | Retry #1 | Final |
|---|---|---|---|
| B05 `/billing/bills` | FAIL：标题不可见 | FAIL：相同原因 | FAIL，UAT-001 |
| B10 1024 `/settlement/list` | FAIL：标题不可见 | FAIL：相同原因 | FAIL，UAT-002 |
| 其余63个test | PASS | 未触发 | PASS |

共67次attempt，0 flaky；没有首次FAIL、retry PASS被静默忽略。

完整运行后将Modal检查中的“等待动画完成”移动到scroll/viewport断言之前，以免入场动画造成几何假阳性；定向重跑全部8个Modal检查，8 PASS、0 FAIL、0 retry，日志 `artifacts/uat/modal-recheck.log`。这8项是原65项的复测，不重复增加Automated。测试代码 TypeScript noEmit 检查通过；报告链接/计数/禁止修改目录差异检查通过。

预跑记录亦保留。脚本开发阶段修正过：页面标题/搜索占位符不一致、Ant Select 文字与输入框遮盖、隐藏 radio 输入需点击可见标签、校验消息动画期间重复匹配，以及 SVG `No data` 标题与可见空态文字的 strict-mode 冲突。这些属于测试实现问题，不列为产品 bug。首次完整候选运行（62 PASS / 3 FAIL）归档到 `artifacts/uat/full-run-01/`，其中 K07 是上述空态定位问题；最终重新建库后完整运行。未通过删除产品断言、`test.fail`、扩大容差或过滤实际错误来制造通过。

## Happy Path Result

账期：`202609`。本次名称 `UAT客户-1789815254688`；资费/用水类别 `UAT_RES_1789815254688`。

| Entity | UI可识别编号 | ID |
|---|---|---|
| Customer | C202609000001 | 01e6a0e7-7bba-4957-9eb5-edc0c262942c |
| Settle account | S202609000001 | c795211b-4f6a-4eb5-a569-e3b4603718ae |
| Water account | A202609000001 | 4b33a0e8-a0ac-4a13-b8fa-be64b5a62162 |
| Meter | M202609000001 | 6644f41a-57f8-4fa2-b820-5b5b8db577cb |
| Book | B202609000001 | 80189bc7-0365-426a-860b-e2dbe442ac7a |
| Payment | P202609000001 | 33152ab2-ee99-41e5-914b-9845843bd313 |
| Receipt | R202609000001 | 627a81c1-bfcd-4ae5-804a-ff4eadec3607 |

| Step | Result | 实际 UI 与响应交叉证据 |
|---|---|---|
| Tariff | PASS | UI 新建 `UAT_RES_<timestamp>`，水费、0→∞、3.000000 元/m³、2026-01-01；草稿→激活→生效中。 |
| Onboard | PASS | 新客户、个人、同名结算户、同 usage category、UAT测试地址、新表、0、新装；成功页回显四类业务编号，响应 meter=INSTALLED、installation=ACTIVE。 |
| Book | PASS | UI 新建成都水务公司抄表册，选择客户/水表户并加入，共 1 户，户号可识别。 |
| Plan | PASS | UI 生成当月计划，待开始、共1/待抄1；开始后进行中，刷新恢复。快速双击生成，SQL 确认仅 1 个计划。 |
| Reading | PASS | UI 选择实抄、读数12，提交后明细已抄。 |
| QC | PASS | 质检页找到待质检实抄12，点击通过，状态变为质检通过。 |
| Settlement | PASS | UI 选客户/水表户/账期生成草稿，用量12、实读，详情含 READING 分量；终审确认明确“终审后不可修改”，终审后刷新保持已终审。 |
| Billing | PASS | UI 新建批次，1张 DRAFT bill，3600分；执行后已过账，成功1/失败0/总1，详情显示¥36.00。 |
| Payment | PASS | UI 客户→水表户查欠费36.00，填自动分摊总额36.00并分摊，现金，双击收款；仅1个 payment，金额3600分，成功回显¥36.00及收据号。 |
| Receipt | PASS | 点击打印票据，响应 printedAt 非空，UI 已打印；刷新欠费无欠费，重载页面并重新选择客户/户后仍为0.00。仅验证系统打印动作。 |
| Day close | PASS | UI 执行今天日结，1笔/¥36.00/现金¥36.00，详情含该收款单。 |
| Reports | PASS | 五张报表均通过 UI 查询并校验数据，明细见下表。 |

| Report | Expected | Actual |
|---|---|---|
| 抄表日报 | 指定抄表册，总户1、已抄1、当日录入1 | PASS，响应计数及可识别册号一致 |
| 收费日报 | 管理员现金1笔¥36.00、已日结 | PASS |
| 应收月报 | 本次用水类别1张账单、¥36.00 | PASS |
| 实收月报 | 实收¥36.00，销账¥36.00，现金¥36.00 | PASS |
| 回收率 | 应收¥36.00，实收¥36.00，100.00% | PASS |

主链证据在 `happy-path-state`、各命名步骤的 `*-ui / *-response / *-screenshot` 附件。报表验证在 NO_READ fixture 建立前执行，未以其它业务数据补足金额。

## Findings

### UAT-001 — 账单页标题不可见，筛选控件重叠

- Severity: P2
- Category: Visual
- Page / Route: `/billing/bills`
- Role: admin
- Precondition: 1440×900，已登录；有/无账单均可复现。
- Steps: 打开“计费管理→账单”；观察顶部标题和客户/水表户筛选区域。
- Expected: “账单”标题可见；各筛选输入独立排列、文字不重叠。
- Actual: 标题 DOM 存在但渲染宽度为0，Playwright `toBeVisible` 失败；客户和水表户筛选区域相互压叠。body 宽1440，scrollWidth=1440，故单纯 overflow 检测无法发现。
- Reproducibility: Always（预跑、正式首次、retry均复现）。
- Evidence: `artifacts/uat/test-results/navigation-B05-K01-smoke-billing-bills-chromium/` 及 `-retry1/` 下 `test-failed-1.png`、`trace.zip`、`video.webm`、`error-context.md`；补充 `artifacts/uat/bills-1440.png`。
- Business impact: 用户难以确认当前页面，筛选条件辨认/点击容易混淆；开账和收费链本轮仍可完成。
- Suggested direction: 后续为标题保留宽度，将筛选区域独立换行，检查客户/水表户联动控件最小宽度；本轮未修改。

### UAT-002 — 1024宽度下结算页面标题消失

- Severity: P2
- Category: Visual
- Page / Route: `/settlement/list`（另观察 `/metering/plans` 标题截为“抄表…”）
- Role: admin
- Precondition: viewport 1024×768，已有本次结算。
- Steps: 打开结算水量，观察页面顶部；对照1280宽度。
- Expected: 标题“结算水量”完整可识别，筛选区不挤占标题。
- Actual: 标题完全不可见；账期、表头文字出现换行。生成按钮仍可操作，body无横向溢出；1280下标题可见。
- Reproducibility: Always（开发预跑、正式首次、retry均复现）。
- Evidence: `artifacts/uat/test-results/responsive-B10-1024-settlement-list-chromium/` 及 `-retry1/` 的失败 screenshot/trace/video；`B10 1024 /settlement/list` 的 `layout-response` 记录1024/1024。
- Business impact: 小屏业务人员缺少页面上下文；操作未被完全阻塞。
- Suggested direction: 后续将标题与筛选分行，明确支持1024布局；不要只以body overflow作为响应式验收标准。

### UAT-003 — 1024宽度资费名称列被挤成逐字纵排

- Severity: P2
- Category: Visual
- Page / Route: `/billing/tariffs`
- Role: admin
- Precondition: viewport 1024×768，存在本次资费 `UAT居民单价` 与唯一长编码。
- Steps: 打开资费计划，查看名称、生效区间与操作列。
- Expected: 名称正常横排或合理省略；必要时表格内部横向滚动。
- Actual: “名称”表头与“UAT居民单价”逐字/极窄换行，单行记录显著增高；日期也拆行。无body overflow，操作按钮仍显示，因此几何自动断言PASS，人工截图检查发现此问题。
- Reproducibility: Always（预跑及最终截图复现）。
- Evidence: HTML 中 `B10 1024 /billing/tariffs` 的 `layout-screenshot`；提取文件 `artifacts/uat/evidence/responsive-B10-1024-billing-tariffs-attempt0-layout-screenshot.png`。
- Business impact: 列表扫描效率下降，长列表下难以比较资费；不影响本轮金额计算。
- Suggested direction: 后续为名称/日期等列设合理最小宽度和表格内部scroll，评估长业务编码下的布局。

### UAT-004 — 中文系统的公共控件仍显示英文

- Severity: P3
- Category: UX
- Page / Route: `/customer/customers`、`/billing/tariffs`、`/metering/plans` 等
- Role: admin（公共控件）
- Precondition: 中文登录；空列表、分页或日期弹窗可见。
- Steps: 客户列表搜索不存在名称；打开资费创建日期输入；查看已有数据的列表分页。
- Expected: 空态、日期占位符/日历、分页等使用中文。
- Actual: 空态 `No data`，日期占位符 `Select date / Select month`，分页 `20 / page`；弹窗关闭按钮可访问名称 `Close`。登录与必填校验错误本身均为中文。
- Reproducibility: Always。
- Evidence: `K07 explicit empty list state` 的页面文本与网络附件；各布局截图中的分页；`B10 modal 1024 /billing/tariffs` 的截图。
- Business impact: 中文使用者理解负担增加，系统语言不一致；非阻塞。
- Suggested direction: 后续核查生产构建中组件库locale的实际生效情况，统一公共控件语言。

### UAT-005 — 未授权直链被静默送回工作台

- Severity: P2
- Category: UX
- Page / Route: 例如 cashier 直接访问 `/system/staff`
- Role: reader / cashier / reviewer
- Precondition: 使用对应 seeded role 的 fixture 账号登录。
- Steps: 地址栏输入未授权业务路由，如 `/system/staff`。
- Expected: route guard阻止进入，并明确提示无权限（清单J06期望403/无权限页）。
- Actual: 安全拦截有效，但直接跳回 `/`，没有“无权限”提示；用户无法判断地址错误还是权限不足。相应越权 API 实测403，不构成权限绕过。
- Reproducibility: Always（三个角色均复现）。
- Evidence: 三个 `J06 ... direct URL denied and backend fail closed via browser proxy` 的 URL断言、`visible-ui`、`denied-*` 和 `browser-network` 附件。
- Business impact: 用户打开分享链接时缺少明确反馈，容易反复尝试或误报系统故障。
- Suggested direction: 后续显示明确中文无权限页面或提示，同时保持后端fail closed。

## Console / Network Errors

| Event | Count (including retry) | Assessment |
|---|---:|---|
| HTTP_OK | 461 | 正常业务/fixture响应 |
| EXPECTED_HTTP_ERROR | 10 | 错误密码401×1；角色越权403×9 |
| console.error | 10 | 全部为上述预期401/403的浏览器资源错误，已逐条按URL/status核对 |
| Unexpected console.error | 0 | PASS |
| pageerror / uncaught JS | 0 | PASS |
| HTTP 5xx | 0 | PASS |
| Unexpected 4xx | 0 | PASS |
| requestfailed | 0 | PASS |
| fetch/XHR proxy bypass | 0 | PASS |

所有主要 suite 自动监听 console、pageerror、requestfailed 与response。仅对已声明的 endpoint + method + status 标记 `EXPECTED_HTTP_ERROR`；这些负面响应及对应浏览器资源错误不算产品缺陷，其余4xx/5xx、网络失败、未捕获异常均保持失败断言。

SQL fixture不模拟业务 UI，通过页面点击发生的业务请求与响应金额/状态均记录。失败trace/video只保存在本地忽略目录。开发期间手工CLI浏览器放置超过token有效期时出现过 `/auth/me` 401；不将这一单次正常过期响应作为产品缺陷，完整session过期场景仍列为未验证。

## Layout Results

| Viewport | Routes / state | Body overflow | UI result |
|---|---|---|---|
| 1440×900 | 28条主路由；主业务链 | 全部无（scrollWidth≤clientWidth+2） | 账单页标题不可见/筛选重叠，UAT-001；其余页面标题可见、无白屏。 |
| 1280×800 | 立户、计划、结算、资费、收费台、日结 | 6/6无 | 列表/表单可操作；4个创建/生成/日结Modal可访问提交按钮。 |
| 1024×768 | 同上6页 | 6/6无 | 结算标题消失、计划标题截断（UAT-002）；资费名称极窄换行（UAT-003）；4个Modal提交按钮可滚动到可视区且横向边界在viewport内。 |

表格内部scroll不计body overflow。Modal等待入场动画完成后测量；超过一屏的内容允许垂直滚动，未将过渡动画截图误记为遮挡缺陷。布局PASS仅代表已执行几何断言，人工发现仍单独列入Findings。收费台附加小屏检查为查询初始态；已选账单的分摊/收款态在1440主链验证，未扩大声称全状态响应式已覆盖。

## Permission Results

| Role | Seeded permissions / UI验证 | Result |
|---|---|---|
| admin | 全部7个业务菜单组；全部路由；主链写操作 | PASS |
| reader | customer:read、metering:read/write；显示客户/抄表；无收费、系统、计费菜单；客户新建按钮不见；资费写POST403 | PASS |
| cashier | customer:read、billing:read、payment:read/write；客户/计费/收费；无抄表/系统/报表；资费新建按钮不见；抄表写POST403 | PASS |
| reviewer | metering:read、billing:read、report:read；显示抄表/计费/报表；无客户/收费/系统；QC通过按钮不见；收费写POST403 | PASS，按实际seed只读权限验收，不假定其有复核写权限 |

非管理员分别验证多条越权直链被阻止，另经页面同源fetch访问受限GET/POST，均403。没有“菜单隐藏但直接URL可操作”。J06安全阻止PASS，但中文拒绝反馈存在UAT-005。未验证ORG_SUBTREE组织外写入、跨租户切换；不把菜单权限通过等同于全部数据范围权限通过。

## Unautomated Checklist Items

以下ID本轮未验证，均不记PASS：

- A07、A08：双租户切换；完整session过期/refresh失败场景。
- B09：浏览器前进后退与菜单高亮同步。
- C04、C05、C06、C08：复用客户/结算户/库存表；CLOSED户。
- D07、D09、D10、D11：批量原子回滚、驳回/复核、更正历史、计划snapshot不变性。
- E03、E04、E05、E06、E07、E08：NO_READ估水、AVG3预览、连续估水、换表、多状态拆表/结算拒绝。D06未抄见录入已验证，但没有把它冒充E03估水通过。
- F01、F02、F03、F04、F05：全部补差业务。
- G05、G06、G07、G08：PARTIAL重试、冻结字段、红冲、重开。
- H04、H05、H06、H09、H10：部分缴费、多单/多笔、日结后红冲、未来日结。H10仅继承清单已知deferred标记，本轮未复现、不重复计入finding。
- J05：ORG_SUBTREE组织外数据写入。
- K05、K10：跨日期/跨账期边界；双tab stale state。

已涉及但仍有未覆盖子场景，不能视为整项所有边界PASS：

| ID | 已验证 | 尚未验证 |
|---|---|---|
| D02 / D03 | 单户加入、顺序/总数1、计划待抄1 | 多成员重排与历史snapshot变化边界 |
| H02 | 单张36元账单全额自动分摊 | 多账单老账优先顺序 |
| I01 | 本次实抄日报册号/计数 | superseded/rejected历史去重 |
| I05 | 本次36/36=100.00% | 0应收、累计through月份等边界 |
| K03 | 双击计划/收费仅产生1份业务单据 | 人工延迟/慢网时所有按钮loading表现 |
| K04 | 终审提示及确认、日结Modal | 红冲确认等未执行破坏性操作 |
| K07 | 客户搜索空态明确存在 | 全页面空态语言一致性（已发现UAT-004） |
| K08 | 登录、计划、结算、收费后的重载 | 全部表单编辑中刷新恢复 |
| K09 | 本次生成计划和全额现金收费快速双击 | 重复提交所有其它业务动作 |

## Recommendation

UAT-PASS

依据指定规则：P0=0且P1=0，P2/P3不阻止进入下一阶段。这并不表示没有缺陷或Playwright全绿：2个布局断言失败，另有人工截图/交互发现。建议下一轮修复并回归本报告5个finding；本轮按要求仅提交测试设施、测试代码与报告，禁止修产品bug。

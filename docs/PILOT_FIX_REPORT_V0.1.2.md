# v0.1.2 Pilot 产品修复报告

## Scope

- 基线：`v0.1.2-mvp` / `f3641013e2c8f1204db84273072ea068864cef64`。
- 修复分支：`fix/pilot-v0.1.2`；原 Pilot 测试及报告先保存在 `696b4d6`。
- 仅处理 PILOT-001–004。没有 schema/migration、计费金额、收款/红冲或补差计算规则变更。
- 本报告描述修复分支的结果，不改变原 tag，也不把原冻结版本描述为已经包含这些修复。
- 浏览器：Google Chrome 153.0.8010.52；生产 Web4173 → `/api` → 生产 API3000。

## Fixes and Evidence

| Finding | 结果 | 修复后行为 | 定向验证 |
|---|---|---|---|
| PILOT-001 | FIXED | 立户可搜索/选择本租户已有水表户和 ACTIVE 资费的用水类别，保留自定义输入；加载失败有中文提示 | 选择已有值、输入新值、空值校验、label关联、跨租户隔离 |
| PILOT-002 | FIXED | reviewer 获得独立 `metering:qc` 权限，可通过/驳回/转人工复核；保留原 `metering:write` 的 QC 能力 | 3种QC UI写动作通过；录入/导入/更正/收费/IAM仍403；cashier QC403；组织范围外403，跨租户404 |
| PILOT-003 | FIXED | 列表/详情显示户号、客户、地址、员工姓名；户号/客户/地址搜索在服务端分页前执行 | 三种搜索、员工姓名、无完整staff对象、另一租户查不到这些数据；1024无body横向溢出 |
| PILOT-004 | FIXED | 净应收为负时回收率显示“—”和中文说明，解释账期应收/收款日期实收 | −¥30应收仍原样显示；API数值未变；不再突出−5844.43%；累计25.36%和零应收提示保持正确 |

Before 保留在 [原 Pilot 报告](PILOT_REPORT_V0.1.2.md#findings)。After 本地证据：

- [类别选择与必填验证](../artifacts/pilot/fixes/evidence/category-picker-screenshot.png)
- [复核员通过读数](../artifacts/pilot/fixes/evidence/qc-pass-screenshot.png)
- [按户号搜索及1024布局](../artifacts/pilot/fixes/evidence/search-accountNo-screenshot.png)
- [负应收回收率说明](../artifacts/pilot/fixes/evidence/negative-recovery-screenshot.png)
- [13项定向回归 HTML](../artifacts/pilot/fixes/html-report/index.html)
- [完整77项 UAT HTML](../artifacts/uat/html-report/index.html)
- [Pilot历史数据复跑 HTML](../artifacts/pilot/p20260919a-fix-replay/html-report/index.html)

截图、trace、video、备份、凭据与业务快照留在 gitignored artifacts，不提交进仓库。

## Verification

执行结果由本轮实际命令输出和 Playwright JSON 固化。Pilot历史复跑是完成态的业务核对，不声称在空库重新完成全部业务写入；新增QC写动作使用独立clone fixture。

| 检查 | 结果 | 环境 |
|---|---|---|
| `pnpm -r build` | PASS | 当前修复代码 |
| API unit | 9/9 PASS | 包含4项权限guard测试 |
| API meter-reading e2e | 27/27 PASS | `water_pilot_fix_api_v012` |
| 原UAT（65原测试+12布局/locale/Forbidden回归） | 77/77 PASS，Failed0，Flaky0，Skipped0 | fresh `water_pilot_fix_uat_v012` |
| 新增Pilot定向回归 | 13/13 PASS，Failed0，Flaky0，Skipped0 | `water_pilot_fix_v012`，post-run备份副本 |
| Pilot持久化场景 | 16/16 PASS，Failed0，Flaky0，Skipped0 | `water_pilot_fix_replay_v012`，原业务身份不变 |

原 UAT 只调整与新职责明确冲突的 reviewer 断言：不再断言“没有通过按钮”，继续断言“没有更正按钮”。新增回归验证QC成功且其他写操作继续拒绝。网络审计只额外识别明确登记的跨租户404及其配套console错误，没有放宽其他错误。

浏览器最终审计：unexpected console/pageerror/HTTP/requestfailed/proxy bypass **全部0**。

| Suite | 成功HTTP | 预期负面HTTP | 配套console错误 | 非预期错误 |
|---|---:|---:|---:|---:|
| UAT77 | 534 | 13 | 13 | 0 |
| 定向13 | 72 | 8 | 8 | 0 |
| Pilot16 | 2883 | 0 | 0 | 0 |

最终耗时：UAT137.30秒、定向18.15秒、Pilot144.92秒。Pilot和定向测试retries=0；UAT配置retries=1但最终没有触发重试。

## Attempts / Failure Accounting

没有删除失败证据，也没有把最终 Flaky0 描述为首跑全绿。

- 初始 RED：9失败/3通过，包含未修复行为、定位适配问题；运行期间Web构建切换，不能用该次负应收结果作RED证据。
- 单独还原冻结版 Reports 页面后：负应收回归按预期失败1项；随后恢复修复版并重新构建。
- 定向测试适配两轮：3失败/10通过、1失败/12通过。原因是必填星号导致accessible name不完全相等、实际按钮名为“复核”、预期404的console分类、AntD虚拟列表隐藏选项重复。按真实可见语义修正，未弱化产品断言。
- Pilot clone 首次完整复跑：15通过/1失败。误改 checkpoint 内部 runId，setup 创建了不同收费员，历史日结无法与新staffId匹配。恢复原 checkpoint 人员标识后重跑；未改收费产品或日结测试断言。
- 失败截图/trace/video：`artifacts/pilot/fixes/attempts/`、`artifacts/pilot/p20260919a-fix-replay/attempts/01-clone-identity-mismatch/`。

## Existing Database Upgrade

新库 seed 已包含 reviewer 的 `metering:qc`。已有库必须使用幂等增量脚本；不能为此重跑完整 seed。

```sh
# 明确指定目标库的 owner URL；每个需要启用的租户分别执行。
MIGRATION_DATABASE_URL=<target-owner-url> pnpm --dir apps/api exec tsx scripts/upgrade-reviewer-qc.ts cd-water
```

脚本只添加权限字典项和 reviewer 绑定，不修改密码、参数或其他权限绑定。需要重新登录以刷新JWT权限。当前本机长期 `water_pilot_v012` 已分别为 `cd-water`、`xh-water` 执行增量授权。

本机 API 已切回长期 `water_pilot_v012`，网页为 **http://127.0.0.1:4173**。使用 Chrome 对该环境完成4项只读检查：类别选择、复核员独立权限、业务身份搜索、负应收说明，unexpected0。账单87、收款28、结算88、读数92、安装46（含既有Pilot-A01）、日结2的完整记录在授权/检查前后逐字比对一致。

本机仍运行当前修复分支的生产构建，未声称已经发布新版本。

完整复现与环境切换见 [tests/pilot-fixes/README.md](../tests/pilot-fixes/README.md)。复跑必须保留 checkpoint 内的 runId 和业务ID；环境 `PILOT_RUN_ID` 可以单独指定输出目录。

## Remaining Scope

原 Pilot 报告的未验证项仍然未验证：真实跨日日结后红冲、多人并发、人工效率、换表后的下一账期结算等。它们没有被本次修复结果自动覆盖。

本次未新增对这些范围的产品开发，未合并main或发布新tag。

## Result

**PILOT-001–004 FIXED；本轮产品修复验证通过。** 原release tag保持不变，后续是否合并/发布单独处理。

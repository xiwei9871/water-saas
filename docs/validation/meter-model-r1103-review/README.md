# 1103 部署后关键风险复核 — 修复记录

分支：`fix/meter-model-r1103-review`（基线 `feat/meter-model-r20261103-review` @ 864ca05）

| 项 | 处置 | 证据 |
|---|---|---|
| P0-1 多户申请提前办结 | 已修复 | activate 仅当 `sourceApplyNo` 下无 PENDING_ASSIGN 残留才置 COMPLETED；spec 改为首户上号=INSTALLING、全部办结=COMPLETED |
| P0-2 抄表员多区号归区不确定 | 已修复 | 多区号必须显式 zoneNo（`ZONE_NO_REQUIRED` 携候选列表）；唯一绑定自动带入；前端多区时渲染必选下拉 |
| P1-1 移动端上号不对齐 | 已修复 | MobileActivate 加候选 AutoComplete+要素带入+段号/频次+口径字典（与桌面端同参） |
| P1-2 候选端点越权 | 已修复 | meterCandidates 校验来源单组织/册成员组织锚点，受限角色无锚点拒 `ORG_OUT_OF_SCOPE` |
| P1-3 历史档案号保护 | 已留存 | 备份 `pre-1103-…172658.dump` 在隔离库 ws_archive_map_tmp 恢复（已删库），提取 `archive-no-map.csv`：28 户中 3 户有旧档案号、3 户均≠户号；SHA256=611521f24dfa525f7123f861ea848b93270380d8fc44ae0518b6954256c3ae4a |
| P1-4 audit_log 失败 | 已修复 | 拦截器 mergeMap 等待审计写入完成再响应——请求成功即审计已落库；失败仍只记日志不阻断（消除 CI teardown「Engine 空响应」噪声根因） |
| P1-4 矩阵纠偏 | 已修正 | G2 营业链 PASS→PARTIAL（无单次完整链证据）；性能脚本注明仅计数查询无造数 |

测试：account-allocation spec 11/11（含新增多区/候选 2 用例）；api/web build PASS。

未做（如实）：放号 1k 批量性能、完整浏览器 UAT 链、185 不再部署（按指示保持现状）。

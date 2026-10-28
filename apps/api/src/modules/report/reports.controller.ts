import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { assertUuid } from '../../common/uuid.js';
import { AnalysisService } from './analysis.service.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { OpsReportService } from './ops-report.service.js';
import { checkSummaryLines } from './report-checks.js';
import { ReportService } from './report.service.js';

/** period is char(6) YYYYMM — same guard as billing/metering controllers. */
const assertPeriod = (v: unknown, field = 'period'): string => {
  if (typeof v !== 'string' || !/^\d{6}$/.test(v)) {
    throw new BadRequestException({ code: 'PERIOD_INVALID', field });
  }
  const month = parseInt(v.slice(4), 10);
  if (month < 1 || month > 12) {
    throw new BadRequestException({ code: 'PERIOD_INVALID', field });
  }
  return v;
};

/** report date is a plain calendar date 'YYYY-MM-DD' — no time component. */
const assertDate = (v: unknown, field = 'date'): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new BadRequestException({ code: 'INVALID_DATE', field });
  }
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new BadRequestException({ code: 'INVALID_DATE', field });
  }
  return v;
};

const required = (v: unknown, field: string): string => {
  if (v === undefined || v === null || v === '') {
    throw new BadRequestException({ code: 'REPORT_PARAM_REQUIRED', field });
  }
  return v as string;
};

/**
 * /reports — the read-only projection layer (spec §4, acceptance
 * "报表四张可对数"). Every endpoint is tenant-scoped, side-effect free
 * and gated by `report:read` — a cashier/biller without the code gets
 * 403, matching the billing:read vs billing:write split. The exact
 * aggregation predicates live on ReportService so the numbers are
 * reproducible against the source tables.
 */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly svc: ReportService,
    private readonly analysis: AnalysisService,
    private readonly ops: OpsReportService,
    private readonly prisma: TenantPrismaService,
  ) {}

  /** 导出落审计 + xlsx 发送（与 query.controller 同一约定）。 */
  private async sendXlsx(
    res: Response,
    action: string,
    aoa: (string | number | null)[][],
    filename: string,
    auditAfter: Record<string, unknown>,
  ) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const ctx = currentTenant();
    try {
      await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            staffId: ctx.staffId,
            action,
            entity: 'report',
            after: auditAfter as never,
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        }),
      );
    } catch (err) {
      console.error('export audit write failed', err);
    }
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  }

  /**
   * GET /reports/meter-daily?date=YYYY-MM-DD[&bookId][&orgUnitId] —
   * 抄表日报： per-book plan-item status counts for the date's period
   * plus same-day readingsTaken. Scoped callers see subtree books only.
   */
  @Get('meter-daily')
  @Permissions('report:read')
  meterDaily(
    @Query('date') date?: string,
    @Query('bookId') bookId?: string,
    @Query('orgUnitId') orgUnitId?: string,
  ) {
    const parsed = {
      date: assertDate(required(date, 'date')),
      bookId: bookId !== undefined ? assertUuid(bookId, 'bookId') : undefined,
      orgUnitId:
        orgUnitId !== undefined ? assertUuid(orgUnitId, 'orgUnitId') : undefined,
    };
    return this.svc.meterDaily(currentTenant(), parsed);
  }

  /**
   * GET /reports/cashier-daily?date=YYYY-MM-DD — 收费日报： per-cashier
   * collections on the date split by channel, with a closed flag when
   * the cashier's day close for that operating date exists.
   */
  @Get('cashier-daily')
  @Permissions('report:read')
  cashierDaily(@Query('date') date?: string) {
    return this.svc.cashierDaily(currentTenant(), {
      date: assertDate(required(date, 'date')),
    });
  }

  /**
   * GET /reports/ar-monthly?period=YYYYMM — 应收月报： billed amount of
   * the period (non-REVERSAL, POSTED|PARTIAL_PAID|PAID) split by
   * usage_category.
   */
  @Get('ar-monthly')
  @Permissions('report:read')
  arMonthly(@Query('period') period?: string) {
    return this.svc.arMonthly(currentTenant(), {
      period: assertPeriod(required(period, 'period')),
    });
  }

  /**
   * GET /reports/collected-monthly?period=YYYYMM — 实收月报： collections
   * received inside the month split by channel, plus the PAYMENT-source
   * alloc-side Σ for the same month. collected and allocated are
   * distinct measures post-E6 (TOP_UP legs bypass payment_alloc) and
   * anchor differently under scope — never assert they are equal.
   */
  @Get('collected-monthly')
  @Permissions('report:read')
  collectedMonthly(@Query('period') period?: string) {
    return this.svc.collectedMonthly(currentTenant(), {
      period: assertPeriod(required(period, 'period')),
    });
  }

  /**
   * GET /reports/recovery-rate?period=YYYYMM[&through=YYYYMM] — 回收率：
   * collected/billed. Single-month window by default; `through` (must
   * be ≥ period) switches to the cumulative Σ ≤ through variant.
   * Tenant-scope only — scoped callers get 403 REPORT_SCOPE_UNDEFINED.
   */
  @Get('recovery-rate')
  @Permissions('report:read')
  recoveryRate(
    @Query('period') period?: string,
    @Query('through') through?: string,
  ) {
    const p = assertPeriod(required(period, 'period'));
    const t = through !== undefined ? assertPeriod(through, 'through') : undefined;
    if (t !== undefined && t < p) {
      throw new BadRequestException({ code: 'PERIOD_INVALID', field: 'through' });
    }
    return this.svc.recoveryRate(currentTenant(), { period: p, through: t });
  }

  /**
   * GET /reports/metric-dictionary — C1 指标字典：25 个 KPI 的口径、
   * 公式、数据源 + version。日/月/年报响应中的 metricVersion 与此
   * 对账；数据源未到位指标返回 available=false + 原因而非静默报 0。
   */
  @Get('metric-dictionary')
  @Permissions('report:read')
  metricDictionary() {
    return this.analysis.metricsDictionary();
  }

  /**
   * GET /reports/ops-daily?date=YYYY-MM-DD — B1 运营日报：当日应收/
   * 实收（当期/陈欠分列）、抄表进度、按组织/渠道/抄表员切片、异常
   * 明细（大额红冲、欠费 TOP）。
   */
  @Get('ops-daily')
  @Permissions('report:read')
  opsDaily(@Query('date') date?: string) {
    return this.analysis.opsDaily(currentTenant(), {
      date: assertDate(required(date, 'date')),
    });
  }

  /**
   * GET /reports/analysis-monthly?period=YYYYMM — B2 经营月报：全量
   * 总量指标（售水量/应收/实收/当期实收/陈欠回收/回收率/欠费/综合
   * 单价/同比环比/抄表四率）+ 分类汇总 + 异常清单。指标 code 与
   * metric-dictionary 一一对应。
   */
  @Get('analysis-monthly')
  @Permissions('report:read')
  analysisMonthly(@Query('period') period?: string) {
    return this.analysis.analysisMonthly(currentTenant(), {
      period: assertPeriod(required(period, 'period')),
    });
  }

  /**
   * GET /reports/analysis-yearly?year=YYYY — B3 年报：年度总量 +
   * 12 个月趋势 + 同比 + 坏账核销/红冲/销户/欠费 TOP 清单。
   */
  @Get('analysis-yearly')
  @Permissions('report:read')
  analysisYearly(@Query('year') year?: string) {
    const y = required(year, 'year');
    if (!/^\d{4}$/.test(y)) {
      throw new BadRequestException({ code: 'PERIOD_INVALID', field: 'year' });
    }
    return this.analysis.analysisYearly(currentTenant(), { year: y });
  }

  /**
   * GET /reports/ops-monthly?period=YYYYMM[&orgUnitId] — 规范月报（修订稿
   * R4/R7）：六大类 21 指标 × 本期/上年同期/同比/本年累计/累计增减，
   * 标题区含公司名称（tenant_param company.name ?? tenant.name）与
   * 填报单位（组织层级）。orgUnitId 按子树∩数据范围收敛。
   */
  @Get('ops-monthly')
  @Permissions('report:read')
  opsMonthly(@Query('period') period?: string, @Query('orgUnitId') orgUnitId?: string) {
    return this.ops.opsMonthly(currentTenant(), {
      period: assertPeriod(required(period, 'period')),
      orgUnitId: orgUnitId ? assertUuid(orgUnitId, 'orgUnitId') : undefined,
    });
  }

  /**
   * GET /reports/ops-yearly?year=YYYY[&orgUnitId][&columns=a,b] — 规范
   * 年度汇总表（R5）：12 行分月 + 合计行；columns 为可勾选列键
   * （soldQty/waterFee/collected/recoveryRate/compositePrice/arrearsTotal）。
   */
  @Get('ops-yearly')
  @Permissions('report:read')
  opsYearly(
    @Query('year') year?: string,
    @Query('orgUnitId') orgUnitId?: string,
    @Query('columns') columns?: string,
  ) {
    const y = required(year, 'year');
    if (!/^\d{4}$/.test(y)) {
      throw new BadRequestException({ code: 'PERIOD_INVALID', field: 'year' });
    }
    return this.ops.opsYearly(currentTenant(), {
      year: y,
      orgUnitId: orgUnitId ? assertUuid(orgUnitId, 'orgUnitId') : undefined,
      columns: columns?.split(',').map((s) => s.trim()).filter(Boolean),
    });
  }

  /**
   * GET /reports/summary-trend?groupBy=ALL|ORG|CATEGORY&years=N[&endYear]
   * —— Q1 汇总趋势：年度汇总行 + 相邻年同比，维度=全公司/片区/用水类别。
   */
  @Get('summary-trend')
  @Permissions('report:read')
  summaryTrend(
    @Query('groupBy') groupBy?: string,
    @Query('years') years?: string,
    @Query('endYear') endYear?: string,
  ) {
    const gb = (groupBy ?? 'ALL').toUpperCase();
    if (!['ALL', 'ORG', 'CATEGORY'].includes(gb)) {
      throw new BadRequestException({ code: 'GROUP_BY_INVALID', value: groupBy });
    }
    const y = years === undefined ? undefined : parseInt(years, 10);
    if (years !== undefined && (!Number.isFinite(y) || (y as number) < 1)) {
      throw new BadRequestException({ code: 'PERIOD_INVALID', field: 'years' });
    }
    const ey = endYear === undefined ? undefined : parseInt(endYear, 10);
    if (endYear !== undefined && (!Number.isFinite(ey) || (ey as number) < 2000)) {
      throw new BadRequestException({ code: 'PERIOD_INVALID', field: 'endYear' });
    }
    return this.ops.unifiedSummary(currentTenant(), {
      groupBy: gb as 'ALL' | 'ORG' | 'CATEGORY',
      years: y,
      endYear: ey,
    });
  }

  /**
   * GET /reports/metric-search?q= —— Q2 指标查询：按名/编码/公式搜索
   * 字典条目（定义/公式/周期/单位/方向/可用性）。
   */
  @Get('metric-search')
  @Permissions('report:read')
  metricSearch(@Query('q') q?: string) {
    return this.ops.metricSearch(q);
  }

  /**
   * GET /reports/metrics/:code/detail?periods=N[&endPeriod=YYYYMM] ——
   * 指标当前值 + 近 N 期趋势（与月报同源 metricsWindow）。
   */
  /**
   * GET /reports/cockpit[?orgUnitId][&periods=N] —— H1 经营驾驶舱五区
   * 聚合：KPI 卡（同比/环比）、当日实时、近 N 月趋势、预警、片区排名。
   */
  @Get('cockpit')
  @Permissions('report:read')
  cockpit(@Query('orgUnitId') orgUnitId?: string, @Query('periods') periods?: string) {
    const n = periods === undefined ? undefined : parseInt(periods, 10);
    if (periods !== undefined && (!Number.isFinite(n) || (n as number) < 1)) {
      throw new BadRequestException({ code: 'PERIOD_INVALID', field: 'periods' });
    }
    return this.ops.cockpit(currentTenant(), {
      orgUnitId: orgUnitId ? assertUuid(orgUnitId, 'orgUnitId') : undefined,
      periods: n,
    });
  }

  @Get('metrics/:code/detail')
  @Permissions('report:read')
  metricDetail(
    @Param('code') code: string,
    @Query('periods') periods?: string,
    @Query('endPeriod') endPeriod?: string,
  ) {
    const n = periods === undefined ? undefined : parseInt(periods, 10);
    if (periods !== undefined && (!Number.isFinite(n) || (n as number) < 1)) {
      throw new BadRequestException({ code: 'PERIOD_INVALID', field: 'periods' });
    }
    return this.ops.metricDetail(currentTenant(), code.toUpperCase(), {
      periods: n,
      endPeriod: endPeriod ? assertPeriod(endPeriod, 'endPeriod') : undefined,
    });
  }

  /** GET /reports/ops-monthly/export —— 规范月报 xlsx（四要素版式）。 */
  @Get('ops-monthly/export')
  @Permissions('report:read')
  async opsMonthlyExport(
    @Query('period') period: string | undefined,
    @Query('orgUnitId') orgUnitId: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Req() _req: Request,
  ) {
    const data = await this.ops.opsMonthly(currentTenant(), {
      period: assertPeriod(required(period, 'period')),
      orgUnitId: orgUnitId ? assertUuid(orgUnitId, 'orgUnitId') : undefined,
    });
    const { meta } = data;
    const aoa: (string | number | null)[][] = [
      [meta.companyName],
      [`营销经营月报表`],
      [`统计周期：${meta.periodLabel}　填报单位：${meta.companyName}${meta.orgLabel === '全公司' ? '' : ' · ' + meta.orgLabel}　金额单位：${meta.unit}　报表期：${meta.periodLabel}`],
      // 1028 v3 表头附注：自检结论 + 异常项清单，随表留档。
      ...checkSummaryLines(data.checkResults).map((l) => [l] as (string | number | null)[]),
      [],
      ['序号', '指标名称', '单位', '本月数', '上年同月', '同比增减(%)', '本年累计', '上年同期累计', '累计增减(%)'],
    ];
    // N6 存档报表固定单位：金额列（行单位=元）按 meta.unit 换算。
    const wan = meta.unit === '万元' ? 1e4 : 1;
    const mv = (rowUnit: string, v: number | null) =>
      v === null ? null : rowUnit === '元' ? v / wan : v;
    for (const s of data.sections) {
      aoa.push([s.name]);
      for (const r of s.rows) {
        aoa.push([
          r.seq, r.name, r.unit,
          mv(r.unit, r.current), mv(r.unit, r.prevYear), r.yoyPct,
          mv(r.unit, r.cum), mv(r.unit, r.prevCum), r.cumYoyPct,
        ]);
      }
    }
    aoa.push([]);
    aoa.push([`编制人：${meta.preparedBy}`, '复核人：', '负责人：', `编制日期：${meta.preparedAt}`]);
    await this.sendXlsx(res, 'EXPORT /reports/ops-monthly', aoa,
      `ops-monthly-${data.period}.xlsx`, { period: data.period, orgUnitId });
  }

  /** GET /reports/ops-yearly/export —— 年度分月汇总表 xlsx。 */
  @Get('ops-yearly/export')
  @Permissions('report:read')
  async opsYearlyExport(
    @Query('year') year: string | undefined,
    @Query('orgUnitId') orgUnitId: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Req() _req: Request,
  ) {
    const y = required(year, 'year');
    if (!/^\d{4}$/.test(y)) {
      throw new BadRequestException({ code: 'PERIOD_INVALID', field: 'year' });
    }
    const data = await this.ops.opsYearly(currentTenant(), {
      year: y,
      orgUnitId: orgUnitId ? assertUuid(orgUnitId, 'orgUnitId') : undefined,
    });
    const { meta } = data;
    const MONEY_COLS = new Set(['waterFee', 'collected', 'arAmount', 'arrearsTotal', 'prepayBalance']);
    const COLS: Record<string, string> = {
      soldQty: '售水量 (m³)', waterFee: '售水收入 (元)', collected: '实收水费 (元)',
      recoveryRate: '水费回收率 (%)', compositePrice: '综合单价 (元/m³)', arrearsTotal: '欠费余额 (元)',
    };
    const cols = data.columns;
    const aoa: (string | number | null)[][] = [
      [meta.companyName],
      ['营销经营年度汇总表'],
      [`统计周期：${meta.periodLabel}　填报单位：${meta.companyName}${meta.orgLabel === '全公司' ? '' : ' · ' + meta.orgLabel}　金额单位：${meta.unit}　报表期：${meta.periodLabel}`],
      // 1028 v3 表头附注：自检结论 + 异常项清单。
      ...checkSummaryLines(data.checkResults).map((l) => [l] as (string | number | null)[]),
      [],
      ['月份', ...cols.map((c) => COLS[c] ?? c)],
      ...data.rows.map((r) => [
        r.month as string,
        ...cols.map((c) => {
          const v = (r as Record<string, unknown>)[c] as number | null;
          // 金额列按 meta.amountUnit 换算（万元/元）
          if (v === null) return null;
          return MONEY_COLS.has(c) && meta.unit === '万元' ? v / 1e4 : v;
        }),
      ]),
      [],
      [`编制人：${meta.preparedBy}`, '复核人：', '负责人：', `编制日期：${meta.preparedAt}`],
    ];
    await this.sendXlsx(res, 'EXPORT /reports/ops-yearly', aoa,
      `ops-yearly-${y}.xlsx`, { year: y, orgUnitId });
  }

  /** GET /reports/summary-trend/export —— 汇总趋势 xlsx（Q1 导出项）。 */
  @Get('summary-trend/export')
  @Permissions('report:read')
  async summaryTrendExport(
    @Query('groupBy') groupBy: string | undefined,
    @Query('years') years: string | undefined,
    @Query('endYear') endYear: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Req() _req: Request,
  ) {
    const gb = (groupBy ?? 'ALL').toUpperCase();
    if (!['ALL', 'ORG', 'CATEGORY'].includes(gb)) {
      throw new BadRequestException({ code: 'GROUP_BY_INVALID', value: groupBy });
    }
    const data = await this.ops.unifiedSummary(currentTenant(), {
      groupBy: gb as 'ALL' | 'ORG' | 'CATEGORY',
      years: years === undefined ? undefined : parseInt(years, 10),
      endYear: endYear === undefined ? undefined : parseInt(endYear, 10),
    });
    const aoa: (string | number | null)[][] = [
      ['年度汇总趋势表'],
      [`维度：${gb === 'ALL' ? '全公司' : gb === 'ORG' ? '片区' : '用水类别'}　年度：${data.years.join('~')}`],
      [],
    ];
    if (gb === 'ALL') {
      aoa.push(['年度', '售水量(m³)', '售水收入(元)', '应收(元)', '实收(元)', '回收率(%)', '综合单价(元/m³)', '欠费余额(元)', '在册户数', '售水量同比(%)', '收入同比(%)', '实收同比(%)']);
      for (const r of data.rows as { year: number; soldQty: number; waterFee: number; arAmount: number; collected: number; recoveryRate: number | null; compositePrice: number | null; arrearsTotal: number; accountCount: number; yoy: Record<string, number | null> }[]) {
        aoa.push([r.year, r.soldQty, r.waterFee, r.arAmount, r.collected, r.recoveryRate, r.compositePrice, r.arrearsTotal, r.accountCount, r.yoy.soldQty, r.yoy.waterFee, r.yoy.collected]);
      }
    } else {
      aoa.push(['分组', '年度', '售水量(m³)', '应收(元)', '实收(元)', '综合单价(元/m³)', '售水量同比(%)', '应收同比(%)', '实收同比(%)']);
      for (const r of data.rows as { group: string; year: number; soldQty: number; arAmount: number; collected: number; compositePrice: number | null; yoy: Record<string, number | null> }[]) {
        aoa.push([r.group, r.year, r.soldQty, r.arAmount, r.collected, r.compositePrice, r.yoy.soldQty, r.yoy.arAmount, r.yoy.collected]);
      }
    }
    await this.sendXlsx(res, 'EXPORT /reports/summary-trend', aoa,
      `summary-trend-${gb}.xlsx`, { groupBy: gb, years, endYear });
  }
}

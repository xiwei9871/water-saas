import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { QueryService, EXPORT_ROW_CAP } from './query.service.js';
import { UnifiedQueryService, type UnifiedQuery } from './unified.service.js';
import {
  THEME_LABELS,
  PERIOD_SPAN_MAX,
  type FieldTheme,
} from './unified-fields.js';

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

const assertDate = (v: unknown, field: string): string => {
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

const num = (v: unknown, field: string): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new BadRequestException({ code: 'REPORT_PARAM_INVALID', field });
  }
  return n;
};

/** F1 统一导出列定义 —— 中文表头，无 UUID 列（A 系列要求"人可理解"）。 */
type Row = Record<string, unknown>;
interface Sheet {
  headers: { key: string; title: string }[];
  rows: Row[];
}

// 与 common/usage-categories.ts 受控集合一致（旧代码表会漏映射导致导出裸枚举）。
const USAGE_CATEGORY_LABELS: Record<string, string> = {
  RES_METERED: '居民户表', RES_SHARED: '居民合表', NON_RES: '非居民',
  SPECIAL: '特种', MONITORING: '监控表',
};
const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  NORMAL: '在册', CLOSED: '销户', SUSPENDED: '暂停',
};
const CHANNEL_LABELS: Record<string, string> = {
  CASH: '现金', POS: 'POS刷卡', TRANSFER: '转账',
  ONLINE: '线上缴费', BANK_DEDUCT: '银行代扣',
};
const READ_SOURCE_LABELS: Record<string, string> = {
  WEB: '页面录入', IMPORT: '批量导入', APP: '移动抄表', REMOTE: '远传',
};
// 与 web billing/common.ts、payment/common.ts 标签同口径
const BILL_STATUS_LABELS: Record<string, string> = {
  DRAFT: '草稿', POSTED: '已出账', PARTIAL_PAID: '部分缴费',
  PAID: '已缴清', REVERSED: '已红冲',
};
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  RECEIVED: '已收款', DAY_CLOSED: '已日结', REVERSED: '已红冲',
};
const BILL_KIND_LABELS: Record<string, string> = {
  NORMAL: '正常账单', ADJUSTMENT: '调账', REPLACEMENT: '换单',
};

const cents = (v: unknown): number | '' =>
  v === null || v === undefined ? '' : Number(v) / 100;
const dateOf = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10);
const timeOf = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : v == null ? '' : String(v);
/** char(6) 账期 → 'YYYY-MM'；逗号分隔的多值逐段转换（allocPeriods）。 */
const fmtPeriod = (v: unknown): string =>
  v == null
    ? ''
    : String(v)
        .split(',')
        .map((p) => (/^\d{6}$/.test(p) ? `${p.slice(0, 4)}-${p.slice(4)}` : p))
        .join('、');

/**
 * A1–A5 查询导出（§四）+ F1 统一导出组件。
 * `?format=xlsx` 返回 .xlsx 附件并写 audit_log（谁、何时、何条件、行数）；
 * 行数硬上限 EXPORT_ROW_CAP 防超时。
 */
@Controller('reports/query')
export class QueryController {
  constructor(
    private readonly svc: QueryService,
    private readonly prisma: TenantPrismaService,
    private readonly unified: UnifiedQueryService,
  ) {}

  @Get('accounts')
  @Permissions('report:read')
  async accounts(
    @Query('orgUnitId') orgUnitId?: string,
    @Query('usageCategory') usageCategory?: string,
    @Query('status') status?: string,
    @Query('caliber') caliber?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const ctx = currentTenant();
    const q = {
      orgUnitId: orgUnitId !== undefined ? assertUuid(orgUnitId, 'orgUnitId') : undefined,
      usageCategory, status, caliber,
      take: num(take, 'take'), skip: num(skip, 'skip'),
    };
    const rows = await this.svc.accounts(ctx, q);
    const sheet: Sheet = {
      headers: [
        { key: 'accountNo', title: '户号' }, { key: 'customerName', title: '户名' },
        { key: 'addr', title: '地址' }, { key: 'usageCategory', title: '用水类别' },
        { key: 'meterNo', title: '表号' }, { key: 'caliber', title: '口径' },
        { key: 'baseReading', title: '表底数' }, { key: 'lastReading', title: '最近读数' },
        { key: 'lastReadPeriod', title: '读数账期' }, { key: 'orgName', title: '所属片区' },
        { key: 'openedAt', title: '立户日期' }, { key: 'status', title: '状态' },
      ],
      rows: rows.map((r) => ({
        ...r,
        usageCategory: USAGE_CATEGORY_LABELS[r.usageCategory] ?? r.usageCategory,
        status: ACCOUNT_STATUS_LABELS[r.status] ?? r.status,
        lastReadPeriod: fmtPeriod(r.lastReadPeriod),
        openedAt: dateOf(r.openedAt),
      })),
    };
    return this.respond(res, format, 'accounts', sheet, ctx, {
      filter: 'accounts', orgUnitId, usageCategory, status, caliber,
    }, rows);
  }

  @Get('usage-details')
  @Permissions('report:read')
  async usageDetails(
    @Query('period') period?: string,
    @Query('waterAccountId') waterAccountId?: string,
    @Query('orgUnitId') orgUnitId?: string,
    @Query('usageCategory') usageCategory?: string,
    @Query('zeroStreak') zeroStreak?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const ctx = currentTenant();
    const q = {
      period: assertPeriod(required(period, 'period')),
      waterAccountId: waterAccountId !== undefined ? assertUuid(waterAccountId, 'waterAccountId') : undefined,
      orgUnitId: orgUnitId !== undefined ? assertUuid(orgUnitId, 'orgUnitId') : undefined,
      usageCategory,
      zeroStreak: num(zeroStreak, 'zeroStreak'),
      take: num(take, 'take'), skip: num(skip, 'skip'),
    };
    const rows = await this.svc.usageDetails(ctx, q);
    const sheet: Sheet = {
      headers: [
        { key: 'accountNo', title: '户号' }, { key: 'customerName', title: '户名' },
        { key: 'period', title: '账期' }, { key: 'prevReading', title: '上期表底' },
        { key: 'endReading', title: '本期表底' }, { key: 'usageQty', title: '本期水量' },
        { key: 'ytdUsage', title: '累计水量' }, { key: 'isEstimated', title: '是否估抄' },
        { key: 'readSource', title: '抄表方式' }, { key: 'readerName', title: '抄表员' },
        { key: 'usageCategory', title: '用水类别' },
      ],
      rows: rows.map((r) => ({
        ...r,
        isEstimated: r.isEstimated ? '估抄' : '实抄',
        usageCategory: USAGE_CATEGORY_LABELS[r.usageCategory] ?? r.usageCategory,
        period: fmtPeriod(r.period),
        // readSource 是 string_agg 多值 —— 逐段映射标签
        readSource:
          r.readSource == null
            ? r.readSource
            : String(r.readSource)
                .split(',')
                .map((s) => READ_SOURCE_LABELS[s] ?? s)
                .join('、'),
      })),
    };
    return this.respond(res, format, 'usage-details', sheet, ctx, {
      filter: 'usage-details', ...q,
    }, rows);
  }

  @Get('bill-details')
  @Permissions('report:read')
  async billDetails(
    @Query('period') period?: string,
    @Query('waterAccountId') waterAccountId?: string,
    @Query('orgUnitId') orgUnitId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const ctx = currentTenant();
    const q = {
      period: assertPeriod(required(period, 'period')),
      waterAccountId: waterAccountId !== undefined ? assertUuid(waterAccountId, 'waterAccountId') : undefined,
      orgUnitId: orgUnitId !== undefined ? assertUuid(orgUnitId, 'orgUnitId') : undefined,
      take: num(take, 'take'), skip: num(skip, 'skip'),
    };
    const rows = await this.svc.billDetails(ctx, q);
    const sheet: Sheet = {
      headers: [
        { key: 'accountNo', title: '户号' }, { key: 'customerName', title: '户名' },
        { key: 'period', title: '账期' }, { key: 'usageQty', title: '水量' },
        { key: 'priceText', title: '单价构成' }, { key: 'totalAmount', title: '应收(元)' },
        { key: 'adjusted', title: '调整/减免(元)' }, { key: 'allocated', title: '实收(元)' },
        { key: 'remaining', title: '欠费(元)' }, { key: 'status', title: '状态' },
      ],
      rows: rows.map((r) => ({
        ...r,
        totalAmount: cents(r.totalAmount),
        adjusted: cents(r.adjusted),
        allocated: cents(r.allocated),
        remaining: cents(r.remaining),
        period: fmtPeriod(r.period),
        status: BILL_STATUS_LABELS[r.status] ?? r.status,
      })),
    };
    return this.respond(res, format, 'bill-details', sheet, ctx, {
      filter: 'bill-details', ...q,
    }, rows);
  }

  @Get('payments')
  @Permissions('report:read')
  async payments(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('channel') channel?: string,
    @Query('settleAccountId') settleAccountId?: string,
    @Query('waterAccountId') waterAccountId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const ctx = currentTenant();
    const q = {
      from: assertDate(required(from, 'from'), 'from'),
      to: assertDate(required(to, 'to'), 'to'),
      channel,
      settleAccountId: settleAccountId !== undefined ? assertUuid(settleAccountId, 'settleAccountId') : undefined,
      waterAccountId: waterAccountId !== undefined ? assertUuid(waterAccountId, 'waterAccountId') : undefined,
      take: num(take, 'take'), skip: num(skip, 'skip'),
    };
    if (q.from > q.to) {
      throw new BadRequestException({ code: 'INVALID_DATE', field: 'from' });
    }
    const rows = await this.svc.payments(ctx, q);
    const sheet: Sheet = {
      headers: [
        { key: 'paymentNo', title: '流水号' }, { key: 'settleNo', title: '结算户号' },
        { key: 'settleName', title: '户名' }, { key: 'accountNos', title: '关联户号' },
        { key: 'receivedAt', title: '缴费日期' }, { key: 'channel', title: '渠道' },
        { key: 'cashierName', title: '收费员' }, { key: 'amount', title: '金额(元)' },
        { key: 'allocPeriods', title: '对应账期' }, { key: 'status', title: '状态' },
      ],
      rows: rows.map((r) => ({
        ...r,
        channel: CHANNEL_LABELS[r.channel] ?? r.channel,
        amount: cents(r.amount),
        receivedAt: timeOf(r.receivedAt),
        allocPeriods: fmtPeriod(r.allocPeriods),
        status: PAYMENT_STATUS_LABELS[r.status] ?? r.status,
      })),
    };
    return this.respond(res, format, 'payments', sheet, ctx, {
      filter: 'payments', ...q,
    }, rows);
  }

  @Get('arrears')
  @Permissions('report:read')
  async arrears(
    @Query('asOf') asOf?: string,
    @Query('agingMin') agingMin?: string,
    @Query('agingMax') agingMax?: string,
    @Query('orgUnitId') orgUnitId?: string,
    @Query('waterAccountId') waterAccountId?: string,
    @Query('minAmount') minAmount?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const ctx = currentTenant();
    const q = {
      asOf: assertDate(required(asOf, 'asOf'), 'asOf'),
      agingMin: num(agingMin, 'agingMin'), agingMax: num(agingMax, 'agingMax'),
      orgUnitId: orgUnitId !== undefined ? assertUuid(orgUnitId, 'orgUnitId') : undefined,
      waterAccountId: waterAccountId !== undefined ? assertUuid(waterAccountId, 'waterAccountId') : undefined,
      minAmount: num(minAmount, 'minAmount'),
      take: num(take, 'take'), skip: num(skip, 'skip'),
    };
    const rows = await this.svc.arrears(ctx, q);
    const aged = rows.filter(
      (r) =>
        (q.agingMin === undefined || r.agingMonths >= q.agingMin) &&
        (q.agingMax === undefined || r.agingMonths <= q.agingMax),
    );
    const sheet: Sheet = {
      headers: [
        { key: 'settleNo', title: '结算户号' }, { key: 'settleName', title: '户名' },
        { key: 'accountNo', title: '用水户号' }, { key: 'customerName', title: '客户名' },
        { key: 'arrearsAmount', title: '欠费金额(元)' }, { key: 'agingMonths', title: '账龄(月)' },
        { key: 'oldestPeriod', title: '欠费起始账期' }, { key: 'billCount', title: '欠费账单数' },
        { key: 'writtenOff', title: '已核销(元)' }, { key: 'phone', title: '联系方式' },
      ],
      rows: aged.map((r) => ({
        ...r,
        arrearsAmount: cents(r.arrearsAmount),
        writtenOff: cents(r.writtenOff),
        oldestPeriod: fmtPeriod(r.oldestPeriod),
      })),
    };
    return this.respond(res, format, 'arrears', sheet, ctx, {
      filter: 'arrears', ...q,
    }, rows);
  }

  /**
   * 统一数据查询（2026-10-15 设计方案）——字段池元数据。
   * 返回按权限过滤后的主题分组，前端据此渲染勾选面板。
   */
  @Get('unified/fields')
  @Permissions('report:read')
  unifiedFields(@Req() req: Request) {
    const perms = (req.user as { perms?: string[] } | undefined)?.perms ?? [];
    const pool = this.unified.fieldPool(perms);
    const themes = (Object.keys(THEME_LABELS) as FieldTheme[]).map((t) => ({
      theme: t,
      label: THEME_LABELS[t],
      fields: pool
        .filter((f) => f.theme === t)
        .map((f) => ({ key: f.key, label: f.label, grain: f.grain })),
    }));
    return { themes, periodSpanMax: PERIOD_SPAN_MAX };
  }

  /**
   * POST /reports/query/unified —— 统一查询执行。
   * 行=用水户；periods 内账期级字段按账期取值；欠费累计按截至
   * periodTo 快照。账期跨度 ≤ PERIOD_SPAN_MAX。
   */
  @Post('unified')
  @Permissions('report:read')
  async unifiedQuery(@Body() body: UnifiedQuery, @Req() req: Request) {
    const perms = (req.user as { perms?: string[] } | undefined)?.perms ?? [];
    const q = this.assertUnified(body);
    return this.unified.unified(currentTenant(), q, perms);
  }

  /**
   * POST /reports/query/unified/export —— 导出当前勾选字段的透视结果
   * （服务端拼列：固定列 + 账期×账期级字段 + 累计列），行数受
   * EXPORT_ROW_CAP 限制并写 audit_log。
   */
  @Post('unified/export')
  @Permissions('report:read')
  async unifiedExport(
    @Body() body: UnifiedQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ctx = currentTenant();
    const perms = (req.user as { perms?: string[] } | undefined)?.perms ?? [];
    const q = this.assertUnified({ ...body, take: EXPORT_ROW_CAP, skip: 0 });
    const data = await this.unified.unified(ctx, q, perms);
    if (data.rows.length > EXPORT_ROW_CAP) {
      throw new BadRequestException({
        code: 'EXPORT_TOO_LARGE',
        cap: EXPORT_ROW_CAP,
      });
    }
    const accountFields = data.fields.filter((f) => f.grain === 'account');
    const periodFields = data.fields.filter((f) => f.grain === 'period');
    const cumFields = data.fields.filter((f) => f.grain === 'cumulative');
    const headers = [
      ...accountFields.map((f) => ({ key: `f_${f.key}`, title: f.label })),
      ...data.periods.flatMap((p) =>
        periodFields.map((f) => ({
          key: `p_${p}_${f.key}`,
          title: `${p.slice(0, 4)}-${p.slice(4)} ${f.label}`,
        })),
      ),
      ...cumFields.map((f) => ({ key: `c_${f.key}`, title: f.label })),
    ];
    const render = (key: string, v: unknown): unknown => {
      if (v === null || v === undefined) return '';
      switch (key) {
        case 'usageCategory':
          return USAGE_CATEGORY_LABELS[String(v)] ?? v;
        case 'accountStatus':
          return ACCOUNT_STATUS_LABELS[String(v)] ?? v;
        case 'billStatus':
          return String(v)
            .split('、')
            .map((s) => BILL_STATUS_LABELS[s] ?? s)
            .join('、');
        case 'billKind':
          return String(v)
            .split('、')
            .map((s) => BILL_KIND_LABELS[s] ?? s)
            .join('、');
        case 'channels':
          return String(v)
            .split('、')
            .map((s) => ({ ...CHANNEL_LABELS, PREPAY: '预存抵扣' })[s] ?? s)
            .join('、');
        case 'readSource':
          return String(v)
            .split(',')
            .map((s) => READ_SOURCE_LABELS[s] ?? s)
            .join('、');
        case 'isEstimated':
          return v === true || v === 'true' ? '估抄' : '实抄';
        case 'totalAmount':
        case 'allocated':
        case 'remaining':
        case 'collectedAmount':
        case 'arrearsAmount':
        case 'writtenOff':
          return cents(v);
        case 'oldestPeriod':
          return fmtPeriod(v);
        case 'openedAt':
        case 'closedAt':
        case 'lastPaidAt':
          return dateOf(v);
        default:
          return v;
      }
    };
    const rows = data.rows.map((r) => {
      const out: Row = {};
      for (const f of accountFields) out[`f_${f.key}`] = render(f.key, r.fixed[f.key]);
      for (const p of data.periods) {
        for (const f of periodFields) {
          out[`p_${p}_${f.key}`] = render(f.key, r.periods[p]?.[f.key]);
        }
      }
      for (const f of cumFields) out[`c_${f.key}`] = render(f.key, r.cumulative[f.key]);
      return out;
    });
    const aoa = [
      headers.map((h) => h.title),
      ...rows.map((r) => headers.map((h) => r[h.key] ?? '')),
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    try {
      await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            staffId: ctx.staffId,
            action: 'EXPORT /reports/query/unified',
            entity: 'report',
            after: {
              params: { ...q, waterAccountIds: undefined },
              rowCount: rows.length,
            } as never,
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
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="export-unified-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    );
    res.send(buf);
  }

  /** 统一查询入参校验（账期格式/跨度/对象 id 列表）。 */
  private assertUnified(body: UnifiedQuery): UnifiedQuery {
    const q = body ?? ({} as UnifiedQuery);
    const periodFrom = assertPeriod(required(q.periodFrom, 'periodFrom'), 'periodFrom');
    const periodTo = assertPeriod(required(q.periodTo, 'periodTo'), 'periodTo');
    if (periodTo < periodFrom) {
      throw new BadRequestException({ code: 'PERIOD_INVALID', field: 'periodTo' });
    }
    const ids = (v: string[] | undefined, field: string) =>
      v === undefined
        ? undefined
        : v.map((x) => assertUuid(x, field));
    if (!Array.isArray(q.fields) || q.fields.length === 0) {
      throw new BadRequestException({ code: 'REPORT_PARAM_REQUIRED', field: 'fields' });
    }
    return {
      ...q,
      periodFrom,
      periodTo,
      waterAccountIds: ids(q.waterAccountIds, 'waterAccountIds'),
      settleAccountIds: ids(q.settleAccountIds, 'settleAccountIds'),
      customerIds: ids(q.customerIds, 'customerIds'),
      bookIds: ids(q.bookIds, 'bookIds'),
      orgUnitId:
        q.orgUnitId !== undefined ? assertUuid(q.orgUnitId, 'orgUnitId') : undefined,
      arrearsMin: q.arrearsMin !== undefined ? num(q.arrearsMin, 'arrearsMin') : undefined,
      agingMin: q.agingMin !== undefined ? num(q.agingMin, 'agingMin') : undefined,
      take: q.take !== undefined ? num(q.take, 'take') : undefined,
      skip: q.skip !== undefined ? num(q.skip, 'skip') : undefined,
    };
  }

  /**
   * format=xlsx → 附件下载 + audit_log 留痕；否则 JSON 行原样返回
   * （JSON 路径不转换金额单位——分，与全站 API 约定一致）。
   */
  private async respond(
    res: Response | undefined,
    format: string | undefined,
    name: string,
    sheet: Sheet,
    ctx: TenantCtx,
    auditMeta: Record<string, unknown>,
    rawRows: unknown[],
  ) {
    if (format !== 'xlsx') {
      // JSON 按全站惯例返回枚举原值（前端各自映射中文标签）；
      // xlsx 列渲染与界面列同口径 —— 导出即所见。
      return rawRows;
    }
    if (!res) throw new BadRequestException({ code: 'REPORT_PARAM_INVALID' });
    if (sheet.rows.length > EXPORT_ROW_CAP) {
      throw new BadRequestException({
        code: 'EXPORT_TOO_LARGE',
        cap: EXPORT_ROW_CAP,
        message: `导出超过 ${EXPORT_ROW_CAP} 行上限，请收窄筛选条件后分批导出`,
      });
    }
    const aoa = [
      sheet.headers.map((h) => h.title),
      ...sheet.rows.map((r) => sheet.headers.map((h) => r[h.key] ?? '')),
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const filename = `export-${name}-${new Date().toISOString().slice(0, 10)}.xlsx`;

    // F1: 导出留痕 —— AuditInterceptor 只覆盖 mutation 方法，GET 导出
    // 在请求内显式补记（await 保证 ALS/连接仍存活；写入失败不阻断下载）。
    try {
      await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            staffId: ctx.staffId,
            action: `EXPORT /reports/query/${name}`,
            entity: 'report',
            after: { params: auditMeta, rowCount: sheet.rows.length } as never,
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
}

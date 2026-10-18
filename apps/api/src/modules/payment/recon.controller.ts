import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { parseReconCsv, ReconService, type ReconRowInput } from './recon.service.js';

const CHANNELS = new Set(['CASH', 'POS', 'TRANSFER', 'ONLINE', 'BANK_DEDUCT']);
const assertDate = (v: unknown, field: string): Date | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new BadRequestException({ code: 'DATE_INVALID', field });
  return d;
};
const assertCents = (v: unknown, field: string): bigint => {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v);
  throw new BadRequestException({ code: 'INVALID_AMOUNT', field });
};

/**
 * G3 渠道对账：POST /payments/recon 上传对账文件逐笔核账；
 * GET /payments/recon/mock-statement 生成模拟通道对账单（真实通道
 * 接入前演示/联调用）；差异挂 RECON_HANDLE 任务。
 */
@Controller('payments/recon')
export class ReconController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly svc: ReconService,
  ) {}

  @Get()
  @Permissions('payment:read')
  list(@Query('take') take?: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.channelReconBatch.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(parseInt(take ?? '50', 10) || 50, 200),
      }),
    );
  }

  @Get('mock-statement')
  @Permissions('payment:read')
  async mockStatement(
    @Query('channel') channel?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const ctx = currentTenant();
    const ch = channel && CHANNELS.has(channel) ? channel : 'ONLINE';
    const rows = await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.payment.findMany({
        where: {
          tenantId: ctx.tenantId,
          channel: ch as never,
          status: { in: ['RECEIVED', 'DAY_CLOSED'] },
          receivedAt: {
            gte: assertDate(from, 'from') ?? new Date(0),
            lte: assertDate(to, 'to') ?? new Date(),
          },
        },
        select: { paymentNo: true, amount: true, receivedAt: true },
        orderBy: { receivedAt: 'asc' },
        take: 1000,
      }),
    );
    const csv = [
      '收款单号,金额(元),支付时间',
      ...rows.map(
        (p) => `${p.paymentNo},${(Number(p.amount) / 100).toFixed(2)},${p.receivedAt.toISOString().slice(0, 19).replace('T', ' ')}`,
      ),
    ].join('\n');
    return { channel: ch, rows: rows.length, content: csv };
  }

  @Get(':id')
  @Permissions('payment:read')
  detail(@Param('id') id: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const batch = await tx.channelReconBatch.findFirst({
        where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id') },
      });
      if (!batch) throw new BadRequestException({ code: 'RECON_NOT_FOUND' });
      const rows = await tx.channelReconRow.findMany({
        where: { tenantId: ctx.tenantId, batchId: batch.id },
        orderBy: { rowNo: 'asc' },
      });
      return { ...batch, rows };
    });
  }

  @Post()
  @Permissions('payment:write')
  upload(
    @Body()
    body: {
      channel?: string;
      fileName?: string;
      bizDateFrom?: string;
      bizDateTo?: string;
      content?: string;
      rows?: { ref?: string; amount?: number | string; paidAt?: string; note?: string }[];
    },
  ) {
    const ctx = currentTenant();
    const channel = body?.channel;
    if (!channel || !CHANNELS.has(channel)) {
      throw new BadRequestException({ code: 'CHANNEL_INVALID' });
    }
    let rows: ReconRowInput[];
    if (Array.isArray(body.rows) && body.rows.length) {
      rows = body.rows.map((r) => {
        if (!r.ref) throw new BadRequestException({ code: 'RECON_ROW_INVALID', field: 'ref' });
        return {
          ref: r.ref,
          amount: assertCents(r.amount, 'amount'),
          paidAt: assertDate(r.paidAt, 'paidAt'),
          note: r.note,
        };
      });
    } else if (typeof body.content === 'string' && body.content.trim()) {
      rows = parseReconCsv(body.content);
    } else {
      throw new BadRequestException({ code: 'RECON_EMPTY' });
    }
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.runTx(tx, ctx, {
        channel,
        fileName: body.fileName,
        bizDateFrom: assertDate(body.bizDateFrom, 'bizDateFrom'),
        bizDateTo: assertDate(body.bizDateTo, 'bizDateTo'),
        rows,
      }),
    );
  }
}

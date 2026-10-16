import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';

const assertCents = (v: unknown, field: string): bigint => {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v);
  throw new BadRequestException({ code: 'INVALID_AMOUNT', field });
};

/**
 * G5 票据台账：
 *  - /payments/receipt-books 收据号段登记/领用/作废；收款时 ISSUED 且
 *    领用人=经手收费员的号段自动占用 next_no（payment.service 调用）。
 *  - /payments/invoices 发票登记（不接税控）：发票号唯一、可作废留痕。
 */
@Controller('payments')
export class ReceiptDocController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get('receipt-books')
  @Permissions('payment:read')
  books() {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.receiptBook.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
      });
      const staffIds = [...new Set(rows.map((r) => r.issuedTo).filter((v): v is string => !!v))];
      const staff = await tx.staff.findMany({
        where: { tenantId: ctx.tenantId, id: { in: staffIds } },
        select: { id: true, name: true },
      });
      const nameOf = new Map(staff.map((s) => [s.id, s.name]));
      return rows.map((r) => ({ ...r, issuedToName: r.issuedTo ? (nameOf.get(r.issuedTo) ?? null) : null }));
    });
  }

  @Post('receipt-books')
  @Permissions('payment:write')
  createBook(
    @Body() body: { bookNo?: string; prefix?: string; rangeStart?: number; rangeEnd?: number },
  ) {
    const ctx = currentTenant();
    const bookNo = body?.bookNo?.trim();
    const start = Number(body?.rangeStart);
    const end = Number(body?.rangeEnd);
    if (!bookNo || bookNo.length > 30) throw new BadRequestException({ code: 'BOOK_NO_INVALID' });
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new BadRequestException({ code: 'RANGE_INVALID' });
    }
    const prefix = (body?.prefix ?? 'S').trim().slice(0, 10) || 'S';
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.receiptBook.create({
        data: {
          tenantId: ctx.tenantId,
          bookNo,
          prefix,
          rangeStart: start,
          rangeEnd: end,
          nextNo: start,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      }),
    );
  }

  /** 领用：把号段指定给收费员（issuedTo 缺省=操作人自己）。 */
  @Put('receipt-books/:id/issue')
  @Permissions('payment:write')
  issue(@Param('id') id: string, @Body() body: { staffId?: string }) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const book = await tx.receiptBook.findFirst({
        where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id') },
      });
      if (!book) throw new BadRequestException({ code: 'BOOK_NOT_FOUND' });
      if (book.status !== 'STOCK') throw new BadRequestException({ code: 'BOOK_NOT_STOCK' });
      const to = body?.staffId ? assertUuid(body.staffId, 'staffId') : ctx.staffId;
      if (body?.staffId) {
        const s = await tx.staff.findFirst({ where: { tenantId: ctx.tenantId, id: to, status: 'ACTIVE' } });
        if (!s) throw new BadRequestException({ code: 'STAFF_NOT_FOUND' });
      }
      return tx.receiptBook.update({
        where: { id: book.id },
        data: { status: 'ISSUED', issuedTo: to, issuedAt: new Date(), updatedBy: ctx.staffId },
      });
    });
  }

  @Put('receipt-books/:id/retire')
  @Permissions('payment:write')
  retire(@Param('id') id: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const r = await tx.receiptBook.updateMany({
        where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id'), status: { in: ['STOCK', 'ISSUED'] } },
        data: { status: 'RETIRED', updatedBy: ctx.staffId },
      });
      if (r.count === 0) throw new BadRequestException({ code: 'BOOK_STATE_INVALID' });
      return tx.receiptBook.findFirst({ where: { id } });
    });
  }

  @Get('invoices')
  @Permissions('payment:read')
  invoices(@Query('waterAccountId') waterAccountId?: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.invoiceRegistry.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(waterAccountId ? { waterAccountId: assertUuid(waterAccountId, 'waterAccountId') } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
  }

  @Post('invoices')
  @Permissions('payment:write')
  createInvoice(
    @Body()
    body: {
      invoiceNo?: string;
      waterAccountId?: string;
      paymentId?: string;
      billId?: string;
      amount?: number | string;
      remark?: string;
    },
  ) {
    const ctx = currentTenant();
    const invoiceNo = body?.invoiceNo?.trim();
    if (!invoiceNo || invoiceNo.length > 30) {
      throw new BadRequestException({ code: 'INVOICE_NO_INVALID' });
    }
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.invoiceRegistry.create({
        data: {
          tenantId: ctx.tenantId,
          invoiceNo,
          waterAccountId: body.waterAccountId ? assertUuid(body.waterAccountId, 'waterAccountId') : null,
          paymentId: body.paymentId ? assertUuid(body.paymentId, 'paymentId') : null,
          billId: body.billId ? assertUuid(body.billId, 'billId') : null,
          amount: assertCents(body.amount, 'amount'),
          remark: body.remark?.slice(0, 200),
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      }),
    );
  }

  @Put('invoices/:id/void')
  @Permissions('payment:write')
  voidInvoice(@Param('id') id: string, @Body() body: { remark?: string }) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const r = await tx.invoiceRegistry.updateMany({
        where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id'), status: 'ISSUED' },
        data: {
          status: 'VOID',
          voidedAt: new Date(),
          voidedBy: ctx.staffId,
          remark: body?.remark?.slice(0, 200),
          updatedBy: ctx.staffId,
        },
      });
      if (r.count === 0) throw new BadRequestException({ code: 'INVOICE_STATE_INVALID' });
      return tx.invoiceRegistry.findFirst({ where: { id } });
    });
  }
}

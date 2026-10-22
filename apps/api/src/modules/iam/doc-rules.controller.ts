import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
} from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

/**
 * 2.4 单据编号规则：租户级前缀配置。
 * 取号时 SequenceService 先查 doc_no_rule——已配前缀覆盖代码默认值；
 * 未配的键展示默认前缀，可就地改成租户习惯的字母（1–4 位 A–Z/0–9）。
 */
const KNOWN_KEYS: { seqKey: string; label: string; defaultPrefix: string }[] = [
  { seqKey: 'customer_no', label: '客户号', defaultPrefix: 'C' },
  { seqKey: 'settle_no', label: '结算户号', defaultPrefix: 'S' },
  { seqKey: 'account_no', label: '用水户号', defaultPrefix: 'A' },
  { seqKey: 'meter_no', label: '水表号', defaultPrefix: 'M' },
  { seqKey: 'book_no', label: '抄表册号', defaultPrefix: 'B' },
  { seqKey: 'payment_no', label: '收款单号', defaultPrefix: 'P' },
  { seqKey: 'receipt_no', label: '票据号', defaultPrefix: 'R' },
  { seqKey: 'collection_notice', label: '催缴通知单号', defaultPrefix: 'CJ' },
  { seqKey: 'service_order', label: '表务工单号', defaultPrefix: 'SG' },
  { seqKey: 'install_apply', label: '报装申请号', defaultPrefix: 'BZ' },
  { seqKey: 'install_contract', label: '供用水合同号', defaultPrefix: 'HT' },
];

const PREFIX_RE = /^[A-Z0-9]{1,4}$/;

@Controller('iam/doc-rules')
export class DocRulesController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get()
  @Permissions('iam:read')
  list() {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rules = await tx.docNoRule.findMany({ where: { tenantId: ctx.tenantId } });
      const byKey = new Map(rules.map((r) => [r.seqKey, r]));
      return KNOWN_KEYS.map((k) => ({
        ...k,
        prefix: byKey.get(k.seqKey)?.prefix ?? k.defaultPrefix,
        customized: byKey.has(k.seqKey),
      }));
    });
  }

  @Put(':seqKey')
  @Permissions('iam:write')
  put(@Param('seqKey') seqKey: string, @Body() body: { prefix?: string }) {
    const key = KNOWN_KEYS.find((k) => k.seqKey === seqKey);
    if (!key) throw new BadRequestException({ code: 'SEQ_KEY_UNKNOWN', seqKey });
    const prefix = (body?.prefix ?? '').trim().toUpperCase();
    if (!PREFIX_RE.test(prefix)) {
      throw new BadRequestException({ code: 'PREFIX_INVALID', hint: '前缀为 1–4 位大写字母或数字' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.docNoRule.upsert({
        where: { tenantId_seqKey: { tenantId: ctx.tenantId, seqKey } },
        create: {
          tenantId: ctx.tenantId,
          seqKey,
          label: key.label,
          prefix,
          updatedBy: ctx.staffId,
        },
        update: { prefix, updatedBy: ctx.staffId },
      }),
    );
  }
}

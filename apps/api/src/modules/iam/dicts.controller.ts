import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  AnyPermissions,
  Permissions,
} from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';

/**
 * G4 统一字典 —— 报表/查询筛选类别与业务原因码的租户级配置表，
 * 替代散落的硬编码枚举。category 收敛为固定集合（拼写错了会让
 * 报表 silently 漏数据），code/name/seq 由租户自管。
 *
 * DISABLED 保留行（历史单据已引用旧值，物理删除会丢含义）。
 * 列表对 report:read 也放行 —— 报表页的筛选下拉由无 iam 权限的
 * 报表用户消费，但写操作仍是 iam:write。
 */
export const DICT_CATEGORIES = [
  { code: 'REVERSAL_TYPE', name: '红冲/退费类型' },
  { code: 'AGING_BUCKET', name: '账龄分段' },
  { code: 'WRITEOFF_REASON', name: '坏账核销原因' },
  { code: 'LOSS_REASON', name: '销户/流失原因' },
  { code: 'ADJUST_TYPE', name: '调整/减免类型' },
] as const;

const CATEGORY_CODES = new Set<string>(DICT_CATEGORIES.map((c) => c.code));

const CODE_RE = /^[A-Z][A-Z0-9_]{0,39}$/;

const assertCategory = (v: unknown): string => {
  if (typeof v !== 'string' || !CATEGORY_CODES.has(v)) {
    throw new BadRequestException({
      code: 'DICT_CATEGORY_INVALID',
      valid: [...CATEGORY_CODES],
    });
  }
  return v;
};

@Controller('iam/dicts')
export class DictsController {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 类别清单（含每个类别的中文名） */
  @Get('categories')
  @AnyPermissions('iam:read', 'report:read', 'payment:read')
  categories() {
    return DICT_CATEGORIES;
  }

  @Get()
  @AnyPermissions('iam:read', 'report:read', 'payment:read')
  list(@Query('category') category?: string, @Query('all') all?: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.sysDict.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(category !== undefined ? { category: assertCategory(category) } : {}),
          ...(all === '1' ? {} : { status: 'ACTIVE' }),
        },
        orderBy: [{ category: 'asc' }, { seq: 'asc' }, { code: 'asc' }],
      }),
    );
  }

  /** POST {category, code, name, seq?, value?} — 新增字典项。 */
  @Post()
  @Permissions('iam:write')
  async create(
    @Body() body: { category?: string; code?: string; name?: string; seq?: number; value?: object },
    @Req() req: Request,
  ) {
    const category = assertCategory(body?.category);
    if (typeof body?.code !== 'string' || !CODE_RE.test(body.code)) {
      throw new BadRequestException({ code: 'DICT_CODE_INVALID' });
    }
    if (typeof body?.name !== 'string' || body.name.trim() === '') {
      throw new BadRequestException({ code: 'DICT_NAME_REQUIRED' });
    }
    const ctx = currentTenant();
    try {
      return await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
        tx.sysDict.create({
          data: {
            tenantId: ctx.tenantId,
            category,
            code: body.code as string,
            name: (body.name as string).trim(),
            seq: typeof body.seq === 'number' ? body.seq : 0,
            ...(body.value !== undefined ? { value: body.value as never } : {}),
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        }),
      );
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as { code?: string }).code === 'P2002'
      ) {
        throw new ConflictException({ code: 'DICT_CODE_DUPLICATE' });
      }
      throw err;
    }
  }

  /** PATCH /:id {name?, seq?, status?, value?} — 改/停用（code 不可改）。 */
  @Patch(':id')
  @Permissions('iam:write')
  async patch(
    @Param('id') id: string,
    @Body() body: { name?: string; seq?: number; status?: string; value?: object },
    @Req() req: Request,
  ) {
    const ctx = currentTenant();
    const dictId = assertUuid(id, 'id');
    if (body?.status !== undefined && body.status !== 'ACTIVE' && body.status !== 'DISABLED') {
      throw new BadRequestException({ code: 'DICT_STATUS_INVALID' });
    }
    if (body?.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
      throw new BadRequestException({ code: 'DICT_NAME_REQUIRED' });
    }
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.sysDict.findUnique({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: dictId } },
      });
      if (!existing) throw new NotFoundException({ code: 'DICT_NOT_FOUND' });
      req.auditBefore = existing;
      return tx.sysDict.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: dictId } },
        data: {
          ...(body.name !== undefined ? { name: body.name.trim() } : {}),
          ...(body.seq !== undefined ? { seq: body.seq } : {}),
          ...(body.status !== undefined
            ? { status: body.status as 'ACTIVE' | 'DISABLED' }
            : {}),
          ...(body.value !== undefined ? { value: body.value as never } : {}),
          updatedBy: ctx.staffId,
        },
      });
    });
  }
}

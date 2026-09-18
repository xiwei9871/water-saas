import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant, orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';

const outOfScope = () =>
  new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

/**
 * Org-unit tree CRUD. All queries go through runAsTenant; callers with a
 * restricted data scope (ORG_SUBTREE/SELF) only see — and may only mutate —
 * orgs inside ctx.orgScope.
 */
@Controller('iam/orgs')
export class OrgsController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  @Get()
  @Permissions('iam:read')
  list() {
    const ctx = currentTenant();
    // ALL-scope callers are not org-filtered — ctx.orgScope is frozen at
    // login, so scoping ALL users would hide orgs created this session.
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.orgUnit.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(ctx.scope === 'ALL' ? {} : { id: { in: ctx.orgScope } }),
        },
        orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  private async createOrgTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: { name?: string; type?: 'COMPANY' | 'BRANCH' | 'DEPT'; parentId?: string | null },
  ) {
    if (body.parentId) {
      const parent = await tx.orgUnit.findFirst({
        where: { tenantId: ctx.tenantId, id: body.parentId },
      });
      if (!parent) throw new NotFoundException({ code: 'ORG_PARENT_NOT_FOUND' });
    }
    return tx.orgUnit.create({
      data: {
        tenantId: ctx.tenantId,
        name: body.name!,
        type: body.type!,
        parentId: body.parentId ?? null,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });
  }

  /**
   * POST /iam/orgs — honors Idempotency-Key like the sibling creates (org_unit
   * has no name uniqueness to fall back on, so a bare retry would dup).
   */
  @Post()
  @Permissions('iam:write')
  async create(
    @Body() body: { name?: string; type?: 'COMPANY' | 'BRANCH' | 'DEPT'; parentId?: string | null },
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.name || !body?.type) {
      throw new BadRequestException({ code: 'ORG_FIELDS_REQUIRED' });
    }
    const ctx = currentTenant();
    // A scoped caller cannot plant a new tree root outside their subtree.
    if (ctx.scope !== 'ALL' && !body.parentId) throw outOfScope();
    if (body.parentId !== undefined && body.parentId !== null) {
      assertUuid(body.parentId, 'parentId');
    }
    if (body.parentId && !orgInScope(ctx, body.parentId)) throw outOfScope();

    if (!key) {
      return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
        this.createOrgTx(tx, ctx, body),
      );
    }
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const result = await this.idem.runWithKey(
      ctx.tenantId,
      { key, method: 'POST', route: '/iam/orgs', requestHash, responseStatus: 201 },
      (tx) => this.createOrgTx(tx, ctx, body),
    );
    return result.body;
  }

  @Patch(':id')
  @Permissions('iam:write')
  async update(
    @Param('id') id: string,
    @Body() body: { name?: string; type?: 'COMPANY' | 'BRANCH' | 'DEPT'; parentId?: string | null },
    @Req() req: Request,
  ) {
    const ctx = currentTenant();
    assertUuid(id, 'id');
    if (!orgInScope(ctx, id)) throw outOfScope();
    if (body.parentId === id) {
      throw new BadRequestException({ code: 'ORG_CYCLE' });
    }
    // Explicit null promotes the org to a root — same restriction as create:
    // a scoped caller must not plant roots outside their subtree.
    if (body.parentId === null && ctx.scope !== 'ALL') throw outOfScope();
    if (body.parentId !== undefined && body.parentId !== null) {
      assertUuid(body.parentId, 'parentId');
    }
    if (body.parentId && !orgInScope(ctx, body.parentId)) throw outOfScope();

    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.orgUnit.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });
      if (body.parentId) {
        const parent = await tx.orgUnit.findFirst({
          where: { tenantId: ctx.tenantId, id: body.parentId },
        });
        if (!parent) throw new NotFoundException({ code: 'ORG_PARENT_NOT_FOUND' });
        // Cycle guard: the new parent must not be the org itself or one of its
        // descendants — otherwise the org tree loops and the login's
        // ORG_SUBTREE recursive CTE would hang. (UNION dedupe is the backstop.)
        const inSubtree = await tx.$queryRaw<{ x: number }[]>`
          WITH RECURSIVE sub AS (
            SELECT id FROM org_unit
            WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid
            UNION
            SELECT o.id FROM org_unit o
            JOIN sub s ON o.parent_id = s.id AND o.tenant_id = ${ctx.tenantId}::uuid
          )
          SELECT 1 AS x FROM sub WHERE id = ${body.parentId}::uuid LIMIT 1`;
        if (inSubtree.length > 0) {
          throw new BadRequestException({ code: 'ORG_CYCLE' });
        }
      }
      req.auditBefore = existing;
      return tx.orgUnit.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: {
          name: body.name,
          type: body.type,
          parentId: body.parentId === undefined ? undefined : body.parentId,
          updatedBy: ctx.staffId,
        },
      });
    });
  }

  @Delete(':id')
  @Permissions('iam:write')
  async remove(@Param('id') id: string, @Req() req: Request) {
    const ctx = currentTenant();
    assertUuid(id, 'id');
    if (!orgInScope(ctx, id)) throw outOfScope();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.orgUnit.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });
      req.auditBefore = existing;
      const children = await tx.orgUnit.count({
        where: { tenantId: ctx.tenantId, parentId: id },
      });
      if (children > 0) {
        throw new BadRequestException({ code: 'ORG_HAS_CHILDREN' });
      }
      const staffCount = await tx.staff.count({
        where: { tenantId: ctx.tenantId, orgUnitId: id },
      });
      if (staffCount > 0) {
        throw new BadRequestException({ code: 'ORG_HAS_STAFF' });
      }
      return tx.orgUnit.delete({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      });
    });
  }
}

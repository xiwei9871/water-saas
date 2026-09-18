import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { assertAdmin } from '../../common/admin.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { conflictOnUnique } from '../../common/prisma-errors.js';
import { currentTenant, orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';

const SAFE_SELECT = {
  id: true,
  tenantId: true,
  orgUnitId: true,
  login: true,
  name: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.StaffSelect;

interface CreateStaffBody {
  login?: string;
  name?: string;
  password?: string;
  orgUnitId?: string;
  roleIds?: string[];
}

const outOfScope = () =>
  new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

/**
 * Write-path guard: the target staff's org (and any org being assigned) must
 * be inside the caller's orgScope. ALL-scope callers bypass. This is what
 * stops an ORG_SUBTREE iam:write holder from reaching into another branch.
 */
const assertOrgWritable = (ctx: TenantCtx, orgUnitId: string | null | undefined) => {
  if (!orgInScope(ctx, orgUnitId)) throw outOfScope();
};

@Controller('iam/staff')
export class StaffController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** List staff, scoped to the caller's orgScope; optional ?orgUnitId filter. */
  @Get()
  @Permissions('iam:read')
  list(@Query('orgUnitId') orgUnitId?: string) {
    const ctx = currentTenant();
    if (orgUnitId && !orgInScope(ctx, orgUnitId)) {
      return [];
    }
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.staff.findMany({
        where: {
          tenantId: ctx.tenantId,
          orgUnitId: orgUnitId ?? { in: ctx.orgScope },
        },
        select: SAFE_SELECT,
        orderBy: { login: 'asc' },
      }),
    );
  }

  private async createStaffTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: CreateStaffBody,
  ) {
    const orgUnitId = assertUuid(body.orgUnitId, 'orgUnitId');
    assertOrgWritable(ctx, orgUnitId);
    const org = await tx.orgUnit.findFirst({
      where: { tenantId: ctx.tenantId, id: orgUnitId },
    });
    if (!org) throw new BadRequestException({ code: 'ORG_UNIT_NOT_FOUND' });

    const roleIds = [...new Set(body.roleIds ?? [])];
    for (const rid of roleIds) assertUuid(rid, 'roleIds');
    if (roleIds.length) {
      const roles = await tx.role.findMany({
        where: { tenantId: ctx.tenantId, id: { in: roleIds } },
      });
      if (roles.length !== roleIds.length) {
        throw new BadRequestException({ code: 'ROLE_NOT_FOUND' });
      }
    }

    const passwordHash = await bcrypt.hash(body.password!, 10);
    const staff = await conflictOnUnique(
      tx.staff.create({
        data: {
          tenantId: ctx.tenantId,
          login: body.login!,
          name: body.name!,
          passwordHash,
          orgUnitId: body.orgUnitId!,
          status: 'ACTIVE',
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: SAFE_SELECT,
      }),
    );
    for (const roleId of roleIds) {
      await tx.staffRole.create({
        data: {
          tenantId: ctx.tenantId,
          staffId: staff.id,
          roleId,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      });
    }
    return staff;
  }

  /**
   * POST /iam/staff — create staff (+ optional role bindings).
   * Honors the Idempotency-Key header: key + business write + COMPLETED mark
   * commit in ONE transaction via IdempotencyService.runWithKey.
   */
  @Post()
  @Permissions('iam:write')
  async create(
    @Body() body: CreateStaffBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.login || !body?.name || !body?.password || !body?.orgUnitId) {
      throw new BadRequestException({ code: 'STAFF_FIELDS_REQUIRED' });
    }
    const ctx = currentTenant();
    // Binding roles at creation is a grant → admin-only. Plain profile
    // creation (no roleIds) stays delegated to orgScope holders.
    if (body.roleIds !== undefined) assertAdmin(req.user);

    if (!key) {
      return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
        this.createStaffTx(tx, ctx, body),
      );
    }

    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const result = await this.idem.runWithKey(
      ctx.tenantId,
      { key, method: 'POST', route: '/iam/staff', requestHash, responseStatus: 201 },
      (tx) => this.createStaffTx(tx, ctx, body),
    );
    return result.body;
  }

  /** PATCH /iam/staff/:id — name/org/status + optional full role replace. */
  @Patch(':id')
  @Permissions('iam:write')
  update(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      orgUnitId?: string;
      status?: 'ACTIVE' | 'DISABLED';
      roleIds?: string[];
    },
    @Req() req: Request,
  ) {
    const ctx = currentTenant();
    // Rebinding roles is a grant → admin-only. Profile-only PATCH stays
    // delegated (orgScope checks on target + new org still apply below).
    if (body.roleIds !== undefined) assertAdmin(req.user);
    assertUuid(id, 'id');
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.staff.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'STAFF_NOT_FOUND' });
      // The target staff must live inside the caller's orgScope — no reaching
      // across branches — and so must any org being assigned.
      assertOrgWritable(ctx, existing.orgUnitId);
      if (body.orgUnitId) {
        assertUuid(body.orgUnitId, 'orgUnitId');
        assertOrgWritable(ctx, body.orgUnitId);
        const org = await tx.orgUnit.findFirst({
          where: { tenantId: ctx.tenantId, id: body.orgUnitId },
        });
        if (!org) throw new BadRequestException({ code: 'ORG_UNIT_NOT_FOUND' });
      }
      req.auditBefore = existing;
      const staff = await tx.staff.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: {
          name: body.name,
          orgUnitId: body.orgUnitId,
          status: body.status,
          updatedBy: ctx.staffId,
        },
        select: SAFE_SELECT,
      });
      if (body.roleIds !== undefined) {
        const roleIds = [...new Set(body.roleIds)];
        for (const rid of roleIds) assertUuid(rid, 'roleIds');
        const roles = await tx.role.findMany({
          where: { tenantId: ctx.tenantId, id: { in: roleIds } },
        });
        if (roles.length !== roleIds.length) {
          throw new BadRequestException({ code: 'ROLE_NOT_FOUND' });
        }
        await tx.staffRole.deleteMany({
          where: { tenantId: ctx.tenantId, staffId: id },
        });
        for (const roleId of roleIds) {
          await tx.staffRole.create({
            data: {
              tenantId: ctx.tenantId,
              staffId: id,
              roleId,
              createdBy: ctx.staffId,
              updatedBy: ctx.staffId,
            },
          });
        }
      }
      return staff;
    });
  }

  /** POST /iam/staff/:id/password — admin-initiated password reset. */
  @Post(':id/password')
  @Permissions('iam:write')
  resetPassword(
    @Param('id') id: string,
    @Body() body: { password?: string },
    @Req() req: Request,
  ) {
    if (!body?.password) {
      throw new BadRequestException({ code: 'PASSWORD_REQUIRED' });
    }
    const ctx = currentTenant();
    assertUuid(id, 'id');
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.staff.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'STAFF_NOT_FOUND' });
      assertOrgWritable(ctx, existing.orgUnitId);
      req.auditBefore = existing;
      const passwordHash = await bcrypt.hash(body.password!, 10);
      await tx.staff.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: { passwordHash, updatedBy: ctx.staffId },
      });
      return { ok: true };
    });
  }
}

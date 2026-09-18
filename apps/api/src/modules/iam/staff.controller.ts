import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

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
    const orgFilter = orgUnitId ?? undefined;
    if (orgFilter && !ctx.orgScope.includes(orgFilter)) {
      return { items: [] };
    }
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.staff.findMany({
        where: {
          tenantId: ctx.tenantId,
          orgUnitId: orgFilter ?? { in: ctx.orgScope },
        },
        select: SAFE_SELECT,
        orderBy: { login: 'asc' },
      }),
    );
  }

  private async createStaffTx(tx: Prisma.TransactionClient, tenantId: string, staffId: string, body: CreateStaffBody) {
    const org = await tx.orgUnit.findFirst({
      where: { tenantId, id: body.orgUnitId! },
    });
    if (!org) throw new BadRequestException({ code: 'ORG_UNIT_NOT_FOUND' });

    const roleIds = body.roleIds ?? [];
    if (roleIds.length) {
      const roles = await tx.role.findMany({ where: { tenantId, id: { in: roleIds } } });
      if (roles.length !== roleIds.length) {
        throw new BadRequestException({ code: 'ROLE_NOT_FOUND' });
      }
    }

    const passwordHash = await bcrypt.hash(body.password!, 10);
    const staff = await tx.staff.create({
      data: {
        tenantId,
        login: body.login!,
        name: body.name!,
        passwordHash,
        orgUnitId: body.orgUnitId!,
        status: 'ACTIVE',
        createdBy: staffId,
        updatedBy: staffId,
      },
      select: SAFE_SELECT,
    });
    for (const roleId of roleIds) {
      await tx.staffRole.create({
        data: { tenantId, staffId: staff.id, roleId, createdBy: staffId, updatedBy: staffId },
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
  async create(@Body() body: CreateStaffBody, @Headers('idempotency-key') key?: string) {
    if (!body?.login || !body?.name || !body?.password || !body?.orgUnitId) {
      throw new BadRequestException({ code: 'STAFF_FIELDS_REQUIRED' });
    }
    const ctx = currentTenant();

    if (!key) {
      return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
        this.createStaffTx(tx, ctx.tenantId, ctx.staffId, body),
      );
    }

    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const result = await this.idem.runWithKey(
      ctx.tenantId,
      { key, method: 'POST', route: '/iam/staff', requestHash, responseStatus: 201 },
      (tx) => this.createStaffTx(tx, ctx.tenantId, ctx.staffId, body),
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
  ) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.staff.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'STAFF_NOT_FOUND' });
      if (body.orgUnitId) {
        const org = await tx.orgUnit.findFirst({
          where: { tenantId: ctx.tenantId, id: body.orgUnitId },
        });
        if (!org) throw new BadRequestException({ code: 'ORG_UNIT_NOT_FOUND' });
      }
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
      if (body.roleIds) {
        const roles = await tx.role.findMany({
          where: { tenantId: ctx.tenantId, id: { in: body.roleIds } },
        });
        if (roles.length !== body.roleIds.length) {
          throw new BadRequestException({ code: 'ROLE_NOT_FOUND' });
        }
        await tx.staffRole.deleteMany({
          where: { tenantId: ctx.tenantId, staffId: id },
        });
        for (const roleId of body.roleIds) {
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
  resetPassword(@Param('id') id: string, @Body() body: { password?: string }) {
    if (!body?.password) {
      throw new BadRequestException({ code: 'PASSWORD_REQUIRED' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.staff.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'STAFF_NOT_FOUND' });
      const passwordHash = await bcrypt.hash(body.password!, 10);
      await tx.staff.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: { passwordHash, updatedBy: ctx.staffId },
      });
      return { ok: true };
    });
  }
}

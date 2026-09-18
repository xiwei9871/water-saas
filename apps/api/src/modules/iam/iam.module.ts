import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OrgsController } from './orgs.controller.js';
import { RolesController } from './roles.controller.js';
import { StaffController } from './staff.controller.js';
import { TenantParamsController } from './tenant-params.controller.js';

/**
 * IAM module: auth (login/refresh/me) + tenant-scoped CRUD for
 * orgs/staff/roles/tenant-params. JwtModule is registered global so the
 * JwtAuthGuard can verify tokens app-wide.
 */
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
    }),
  ],
  controllers: [
    AuthController,
    OrgsController,
    StaffController,
    RolesController,
    TenantParamsController,
  ],
  providers: [TenantPrismaService, AuthService, IdempotencyService],
  exports: [TenantPrismaService, AuthService, IdempotencyService],
})
export class IamModule {}

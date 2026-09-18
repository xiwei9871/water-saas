import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditLogsController } from './audit-logs.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OrgsController } from './orgs.controller.js';
import { RolesController } from './roles.controller.js';
import { StaffController } from './staff.controller.js';
import { TenantParamsController } from './tenant-params.controller.js';

/**
 * JWT_SECRET is mandatory in production (fail-fast at startup). In dev/test
 * the well-known fallback is accepted but loudly warned about — a leaked dev
 * secret must never reach a real deployment unnoticed.
 */
const jwtSecret = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required when NODE_ENV=production');
  }
  if (!secret) {
    console.warn('[iam] JWT_SECRET unset — using dev fallback secret');
  }
  return secret ?? 'dev-secret-change-me';
})();

/**
 * IAM module: auth (login/refresh/me) + tenant-scoped CRUD for
 * orgs/staff/roles/tenant-params. JwtModule is registered global so the
 * JwtAuthGuard can verify tokens app-wide. TenantPrismaService /
 * IdempotencyService come from the global CommonModule (single pool).
 */
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: jwtSecret,
      signOptions: { algorithm: 'HS256' },
      verifyOptions: { algorithms: ['HS256'] },
    }),
  ],
  controllers: [
    AuthController,
    OrgsController,
    StaffController,
    RolesController,
    TenantParamsController,
    AuditLogsController,
  ],
  providers: [AuthService],
  exports: [AuthService],
})
export class IamModule {}

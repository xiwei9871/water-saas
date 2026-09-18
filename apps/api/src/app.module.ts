import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuditInterceptor } from './common/audit.interceptor.js';
import { JwtAuthGuard } from './common/auth.guard.js';
import { BigIntInterceptor } from './common/bigint.interceptor.js';
import { CommonModule } from './common/common.module.js';
import { PermissionsGuard } from './common/permissions.guard.js';
import { TenantInterceptor } from './common/tenant.interceptor.js';
import { CustomerModule } from './modules/customer/customer.module.js';
import { IamModule } from './modules/iam/iam.module.js';
import { MeteringModule } from './modules/metering/metering.module.js';

@Module({
  imports: [CommonModule, IamModule, CustomerModule, MeteringModule],
  controllers: [AppController],
  providers: [
    AppService,
    // Guard order: authenticate (JWT → req.user) then authorize (@Permissions).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Interceptor order (outermost first): ALS tenant context → audit →
    // BigInt/Decimal-safe JSON.
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: BigIntInterceptor },
  ],
})
export class AppModule {}

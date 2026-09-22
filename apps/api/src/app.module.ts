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
import { BillingModule } from './modules/billing/billing.module.js';
import { CustomerModule } from './modules/customer/customer.module.js';
import { IamModule } from './modules/iam/iam.module.js';
import { IntegrationModule } from './modules/integration/integration.module.js';
import { MeteringModule } from './modules/metering/metering.module.js';
import { PaymentModule } from './modules/payment/payment.module.js';
import { PrepaymentModule } from './modules/prepayment/prepayment.module.js';
import { RemoteModule } from './modules/remote/remote.module.js';
import { ReportModule } from './modules/report/report.module.js';

@Module({
  imports: [
    CommonModule,
    IamModule,
    CustomerModule,
    MeteringModule,
    RemoteModule,
    PrepaymentModule,
    BillingModule,
    PaymentModule,
    ReportModule,
    IntegrationModule,
  ],
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

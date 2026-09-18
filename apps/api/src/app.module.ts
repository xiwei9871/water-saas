import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { TenantPrismaService } from './common/tenant-prisma.js';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, TenantPrismaService],
  exports: [TenantPrismaService],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { CustomerModule } from '../customer/customer.module.js';
import { TaskModule } from '../task/task.module.js';
import { InstallController } from './install.controller.js';
import { InstallService } from './install.service.js';

/**
 * 报装模块（S1）——业扩报装独立域：申请→勘察→审批→装表→归档。
 * 归档复用 customer 域的立户向导事务（onboardTx）；模块边界清晰，
 * 如需拆分为独立服务，整体迁出 + 归档步改走 customer 端口即可。
 */
@Module({
  imports: [CustomerModule, TaskModule],
  controllers: [InstallController],
  providers: [InstallService],
})
export class InstallModule {}

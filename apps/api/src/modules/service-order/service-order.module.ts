import { Module } from '@nestjs/common';
import { CustomerModule } from '../customer/customer.module.js';
import { TaskModule } from '../task/task.module.js';
import { ServiceOrderController } from './service-order.controller.js';
import { ServiceOrderService } from './service-order.service.js';

/**
 * 表务管理（20261019 整合需求 T1-T6, T11, T12）— 11 类表务处置统一
 * 工单流。依赖方向 iam ← customer ← service-order：执行联动复用
 * CustomerModule 导出的 WaterAccountService/MeterInstallationService/
 * CloseAccountUseCase；派单复用 TaskModule 的 TaskService。
 */
@Module({
  imports: [CustomerModule, TaskModule],
  controllers: [ServiceOrderController],
  providers: [ServiceOrderService],
})
export class ServiceOrderModule {}

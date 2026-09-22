import { Module } from '@nestjs/common';
import { RemoteDeviceController } from './remote-device.controller.js';
import { RemoteDeviceService } from './remote-device.service.js';
import { RemoteEventController } from './remote-event.controller.js';
import { RemoteEventService } from './remote-event.service.js';
import { RemoteEventProcessorService } from './remote-processor.service.js';
import { RemoteSourceController } from './remote-source.controller.js';
import { RemoteSourceService } from './remote-source.service.js';

/**
 * Remote module （远传接入， E5) — vendor platform → canonical event →
 * RawRemoteEvent → resolution → MeterReading → QC → Settlement. Adapters
 * never write settlement/bill facts directly.
 *
 * TenantPrismaService/IdempotencyService/SequenceService are global via
 * CommonModule.
 */
@Module({
  controllers: [RemoteSourceController, RemoteDeviceController, RemoteEventController],
  providers: [RemoteSourceService, RemoteDeviceService, RemoteEventService, RemoteEventProcessorService],
})
export class RemoteModule {}

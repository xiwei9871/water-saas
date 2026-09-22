import { Module } from '@nestjs/common';
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
  controllers: [RemoteSourceController],
  providers: [RemoteSourceService],
})
export class RemoteModule {}

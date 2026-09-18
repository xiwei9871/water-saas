import { Module } from '@nestjs/common';
import {
  PaymentChannelPort,
  ReportInstallPort,
  SmartMeterPort,
  SmsPort,
  StubPaymentChannelPort,
  StubReportInstallPort,
  StubSmartMeterPort,
  StubSmsPort,
} from './ports.js';

/**
 * Integration module (spec §2.8) — binds every external port to its
 * fail-loud stub. A real adapter (SMS gateway, payment channel, smart
 * meter platform, install-order exchange) replaces exactly one provider
 * binding; the kernel only ever sees the port token. Providers are
 * exported so a future feature module can inject the ports.
 */
@Module({
  providers: [
    { provide: SmsPort, useClass: StubSmsPort },
    { provide: PaymentChannelPort, useClass: StubPaymentChannelPort },
    { provide: SmartMeterPort, useClass: StubSmartMeterPort },
    { provide: ReportInstallPort, useClass: StubReportInstallPort },
  ],
  exports: [SmsPort, PaymentChannelPort, SmartMeterPort, ReportInstallPort],
})
export class IntegrationModule {}

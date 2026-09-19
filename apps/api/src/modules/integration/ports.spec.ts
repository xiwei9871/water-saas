import { NotImplementedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IntegrationModule } from './integration.module.js';
import {
  PaymentChannelPort,
  ReportInstallPort,
  SmartMeterPort,
  SmsPort,
} from './ports.js';

/**
 * Integration stub smoke (T13): every §2.8 port resolves through the
 * module's provider bindings and fails loudly — a stub must never
 * silently succeed (a no-op would tell the kernel an SMS was sent).
 */
describe('IntegrationModule port stubs', () => {
  const compile = () =>
    Test.createTestingModule({ imports: [IntegrationModule] }).compile();

  const expectNotImplemented = (fn: () => unknown) => {
    try {
      fn();
      throw new Error('stub did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplementedException);
      expect((err as NotImplementedException).getResponse()).toMatchObject({
        code: 'NOT_IMPLEMENTED',
      });
    }
  };

  it('SmsPort resolves and send() throws NOT_IMPLEMENTED', async () => {
    const moduleRef = await compile();
    const port = moduleRef.get(SmsPort);
    expectNotImplemented(() => port.send('+10000000000', 'BILL_READY', {}));
    await moduleRef.close();
  });

  it('PaymentChannelPort resolves and charge() throws NOT_IMPLEMENTED', async () => {
    const moduleRef = await compile();
    const port = moduleRef.get(PaymentChannelPort);
    expectNotImplemented(() =>
      port.charge({
        paymentNo: 'P000000000001',
        settleAccountId: '00000000-0000-4000-8000-000000000000',
        channel: 'TRANSFER',
        amount: 100n,
      }),
    );
    await moduleRef.close();
  });

  it('SmartMeterPort resolves and fetchReadings() throws NOT_IMPLEMENTED', async () => {
    const moduleRef = await compile();
    const port = moduleRef.get(SmartMeterPort);
    expectNotImplemented(() => port.fetchReadings({ period: '202610' }));
    await moduleRef.close();
  });

  it('ReportInstallPort resolves and both methods throw NOT_IMPLEMENTED', async () => {
    const moduleRef = await compile();
    const port = moduleRef.get(ReportInstallPort);
    expectNotImplemented(() =>
      port.submitInstallOrder({
        waterAccountId: '00000000-0000-4000-8000-000000000000',
        payload: {},
      }),
    );
    expectNotImplemented(() => port.fetchInstallUpdates({}));
    await moduleRef.close();
  });
});

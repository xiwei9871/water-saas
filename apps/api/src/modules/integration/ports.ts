import { Injectable, NotImplementedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Integration ports (spec §2.8) — the kernel's seam to external systems.
 * Every external integration is OUT of MVP scope (spec §7 明确不做：
 * 第三方在线支付 / 短信 / 智能表平台 / 在网表工单）, so each port ships
 * with exactly one bound implementation: a stub that fails LOUDLY with
 * 501 NOT_IMPLEMENTED. A stub must never silently succeed — a no-op
 * would let the kernel believe an SMS was sent or a channel charged.
 *
 * Ports are abstract classes (not TS interfaces) so each one doubles as
 * its own NestJS DI token — the same convention FinancePort established
 * in customer/ports (an interface cannot be a provider token).
 *
 * FinancePort is NOT redeclared here: the live port ("how much does this
 * water account still owe") already exists at
 * `src/modules/customer/ports/finance.port.ts`, bound to
 * BillingFinancePort via `useExisting` in CustomerModule (T10/T12).
 * T13's consolidation is documentation-only — the real port migrates
 * here when the module wiring is revisited, not now (moving it would
 * churn CustomerModule's imports for zero behavioral gain).
 */

/** 短信网关 — templated SMS to a customer phone number. */
export abstract class SmsPort {
  /**
   * Send one templated message. `to` is the E.164/local phone number,
   * `template` the provider-side template code, `params` the template
   * variables (all strings — providers flatten them positionally).
   */
  abstract send(
    to: string,
    template: string,
    params: Record<string, string>,
  ): Promise<void>;
}

/** 在线支付渠道 — a third-party charge against a settle account. */
export abstract class PaymentChannelPort {
  /**
   * Initiate a channel charge. `paymentNo` is OUR document number (the
   * idempotency handle at the channel); `amount` integer cents. The
   * channel's own reference comes back for reconciliation.
   */
  abstract charge(req: {
    paymentNo: string;
    settleAccountId: string;
    channel: string;
    amount: bigint;
  }): Promise<{ channelRef: string; status: 'SUCCEEDED' | 'PENDING' | 'FAILED' }>;
}

/** 智能表平台 — remote/automatic meter reading pull (ReadSource.REMOTE). */
export abstract class SmartMeterPort {
  /**
   * Pull readings for a billing period, optionally narrowed to a meter
   * list. Returned values are raw dial positions — installation/meter
   * resolution stays on the kernel side.
   */
  abstract fetchReadings(req: {
    period: string;
    meterNos?: string[];
  }): Promise<{ meterNo: string; readingValue: Prisma.Decimal; readDate: Date }[]>;
}

/** 报装工单 — new-installation work-order data exchange. */
export abstract class ReportInstallPort {
  /**
   * Push an approved install order out to the field-work system.
   * `waterAccountId` anchors the new point; payload is opaque to the
   * kernel (address/meter spec/customer contact go inside).
   */
  abstract submitInstallOrder(req: {
    waterAccountId: string;
    payload: Record<string, unknown>;
  }): Promise<{ orderRef: string }>;

  /** Pull status updates on previously submitted orders. */
  abstract fetchInstallUpdates(req: {
    since?: Date;
  }): Promise<{ orderRef: string; status: string; occurredAt: Date }[]>;
}

const notImplemented = (port: string) =>
  new NotImplementedException({ code: 'NOT_IMPLEMENTED', port });

@Injectable()
export class StubSmsPort extends SmsPort {
  send(): Promise<void> {
    throw notImplemented('sms');
  }
}

@Injectable()
export class StubPaymentChannelPort extends PaymentChannelPort {
  charge(): Promise<{ channelRef: string; status: 'SUCCEEDED' | 'PENDING' | 'FAILED' }> {
    throw notImplemented('payment-channel');
  }
}

@Injectable()
export class StubSmartMeterPort extends SmartMeterPort {
  fetchReadings(): Promise<
    { meterNo: string; readingValue: Prisma.Decimal; readDate: Date }[]
  > {
    throw notImplemented('smart-meter');
  }
}

@Injectable()
export class StubReportInstallPort extends ReportInstallPort {
  submitInstallOrder(): Promise<{ orderRef: string }> {
    throw notImplemented('report-install');
  }

  fetchInstallUpdates(): Promise<
    { orderRef: string; status: string; occurredAt: Date }[]
  > {
    throw notImplemented('report-install');
  }
}

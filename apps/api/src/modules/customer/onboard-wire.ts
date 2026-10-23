import { BadRequestException } from '@nestjs/common';
import { assertDecimal, assertOptionalDate } from '../../common/decimal.js';
import { assertUuid } from '../../common/uuid.js';
import type { CustomerBody } from './customer.service.js';
import type { MeterBody } from './meter.service.js';
import type { SettleAccountBody } from './settle-account.service.js';
import type { OnboardBody } from './water-account.service.js';

export const CUST_TYPES = new Set(['PERSONAL', 'ORG']);
export const INSTALL_REASONS = new Set(['NEW', 'REPLACE', 'FAULT', 'PERIODIC_CHECK']);

export interface OnboardWireBody {
  customer?: CustomerBody;
  customerId?: string;
  settleAccount?: SettleAccountBody;
  settleAccountId?: string;
  account?: {
    accountNo?: string;
    usageCategory?: string;
    addr?: string;
    openedAt?: unknown;
    householdSize?: unknown;
  };
  meter?: MeterBody & { maxDial?: unknown };
  meterId?: string;
  installation?: {
    initialReading?: unknown;
    installedAt?: unknown;
    reason?: string;
  };
  /** 报装纳入：来源报装单号（可选，回写户/客户/表 source_apply_no）。 */
  sourceApplyNo?: string;
  /** B1：立户即入册（可选，reading_book id）。 */
  readingBookId?: string;
}

/**
 * POST /water-accounts/onboard 与 POST /install/applications/:id/archive
 * 共用的线体→领域体校验/转型。归档场景可 `allowNoCustomer`（客户由申请单补全）。
 */
export function parseOnboardWire(
  body: OnboardWireBody,
  opts: { allowNoCustomer?: boolean } = {},
): OnboardBody {
  const isMonitoring = body?.account?.usageCategory === 'MONITORING';
  const hasCustomer = !!body?.customer;
  const hasCustomerId = !!body?.customerId;
  // Monitoring meters hang off the system customer — caller supplies
  // none, and a supplied one would be silently ignored, so refuse it.
  if (isMonitoring && (hasCustomer || hasCustomerId)) {
    throw new BadRequestException({ code: 'MONITORING_NO_CUSTOMER' });
  }
  if (!isMonitoring && hasCustomer === hasCustomerId && !(opts.allowNoCustomer && !hasCustomer)) {
    throw new BadRequestException({ code: 'ONBOARD_CUSTOMER_XOR' });
  }
  if (body.customer && (!body.customer.name || !body.customer.custType)) {
    throw new BadRequestException({ code: 'CUSTOMER_FIELDS_REQUIRED' });
  }
  if (body.customer?.custType && !CUST_TYPES.has(body.customer.custType)) {
    throw new BadRequestException({ code: 'CUST_TYPE_INVALID' });
  }
  // Same ignore-vs-refuse rule for settle accounts: monitoring uses the
  // internal system settle account, caller input must not be accepted.
  if (isMonitoring && (body.settleAccount || body.settleAccountId)) {
    throw new BadRequestException({ code: 'MONITORING_NO_CUSTOMER' });
  }
  if (!isMonitoring && body.settleAccount && body.settleAccountId) {
    throw new BadRequestException({ code: 'ONBOARD_SETTLE_ACCOUNT_XOR' });
  }
  if (!isMonitoring && body.settleAccount && !body.settleAccount.name) {
    throw new BadRequestException({ code: 'SETTLE_ACCOUNT_FIELDS_REQUIRED' });
  }
  if (!body.account?.usageCategory || !body.account?.addr) {
    throw new BadRequestException({ code: 'WATER_ACCOUNT_FIELDS_REQUIRED' });
  }
  const hasMeter = !!body?.meter;
  const hasMeterId = !!body?.meterId;
  if (hasMeter === hasMeterId) {
    throw new BadRequestException({ code: 'ONBOARD_METER_XOR' });
  }
  if (!body.installation || body.installation.initialReading === undefined) {
    throw new BadRequestException({ code: 'INSTALLATION_FIELDS_REQUIRED' });
  }
  if (
    body.installation.reason !== undefined &&
    !INSTALL_REASONS.has(body.installation.reason)
  ) {
    throw new BadRequestException({ code: 'INSTALL_REASON_INVALID' });
  }

  return {
    customer: body.customer,
    customerId: body.customerId ? assertUuid(body.customerId, 'customerId') : undefined,
    settleAccount: body.settleAccount,
    settleAccountId: body.settleAccountId
      ? assertUuid(body.settleAccountId, 'settleAccountId')
      : undefined,
    account: {
      accountNo: body.account.accountNo,
      usageCategory: body.account.usageCategory,
      addr: body.account.addr,
      openedAt: assertOptionalDate(body.account.openedAt, 'account.openedAt'),
      householdSize:
        body.account.householdSize !== undefined
          ? (() => {
              const n = Number(body.account!.householdSize);
              if (!Number.isInteger(n) || n < 0) {
                throw new BadRequestException({ code: 'INVALID_HOUSEHOLD_SIZE' });
              }
              return n;
            })()
          : undefined,
    },
    meter: body.meter
      ? {
          ...body.meter,
          maxDial:
            body.meter.maxDial !== undefined
              ? assertDecimal(body.meter.maxDial, 'meter.maxDial')
              : undefined,
        }
      : undefined,
    meterId: body.meterId ? assertUuid(body.meterId, 'meterId') : undefined,
    installation: {
      initialReading: assertDecimal(body.installation.initialReading, 'installation.initialReading', { min: 0 }),
      installedAt: assertOptionalDate(body.installation.installedAt, 'installation.installedAt'),
      reason: body.installation.reason as OnboardBody['installation']['reason'],
    },
    sourceApplyNo: body.sourceApplyNo?.trim() || undefined,
    readingBookId: body.readingBookId
      ? assertUuid(body.readingBookId, 'readingBookId')
      : undefined,
  };
}

import type { PayChannel, PaymentStatus } from '../../api/types';

/** 收费域共享的枚举中文标签 / 颜色。 */

export const PAY_CHANNEL_LABELS: Record<PayChannel, string> = {
  CASH: '现金',
  POS: 'POS 刷卡',
  TRANSFER: '转账',
};

export const PAY_CHANNEL_COLORS: Record<PayChannel, string> = {
  CASH: 'green',
  POS: 'blue',
  TRANSFER: 'purple',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  RECEIVED: '已收款',
  DAY_CLOSED: '已日结',
  REVERSED: '已红冲',
};

export const PAYMENT_STATUS_COLORS: Record<PaymentStatus, string> = {
  RECEIVED: 'green',
  DAY_CLOSED: 'cyan',
  REVERSED: 'default',
};

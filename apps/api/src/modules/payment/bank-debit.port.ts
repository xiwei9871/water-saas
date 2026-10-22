import { Injectable } from '@nestjs/common';

/**
 * 20261021 整改 任务F：银行直连接口的端口抽象。
 * 真实银行通道（银企直连/网联清算）延后接入 —— 现阶段 Mock 适配器模拟：
 * 卡尾号 9999 → 失败'余额不足'；其他 → 成功并回传银行流水号。
 * 接口签名按真实银行约定设计，后续仅替换适配器实现即可。
 */
export interface DebitChargeRequest {
  itemId: string;
  settleAccountId: string;
  /** 分。 */
  amount: bigint;
  cardLast4: string;
  bankCode: string;
  period: string;
}

export interface DebitChargeResult {
  ok: boolean;
  /** 银行流水号（成功时必有）。 */
  bankSerialNo?: string;
  failReason?: string;
}

export interface BankDebitPort {
  charge(req: DebitChargeRequest): Promise<DebitChargeResult>;
}

export const BANK_DEBIT_PORT = 'BANK_DEBIT_PORT';

/** Mock：尾号 9999 余额不足失败；其余成功，serial = `MOCK-{itemId 短码}`。 */
@Injectable()
export class MockBankDebitAdapter implements BankDebitPort {
  async charge(req: DebitChargeRequest): Promise<DebitChargeResult> {
    if (req.cardLast4 === '9999') {
      return { ok: false, failReason: '余额不足' };
    }
    return { ok: true, bankSerialNo: `MOCK-${req.itemId.slice(0, 8).toUpperCase()}` };
  }
}

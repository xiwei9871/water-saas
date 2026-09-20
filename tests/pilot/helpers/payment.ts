import type { PilotState } from './state';
export const channels = ['CASH', 'POS', 'TRANSFER'] as const;
export const channelLabels = { CASH: '现金', POS: 'POS 刷卡', TRANSFER: '转账' };
export const cents = (value: unknown) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Not integer cents: ${value}`);
  return n;
};
export const money = (value: unknown) => `¥${(cents(value) / 100).toFixed(2)}`;
export const transactions = (s: PilotState): any[] => [...s.payments, ...(s.reversals || [])];
export function outstanding(s: PilotState, billId: string) {
  const bill = s.bills.find(b => b.id === billId);
  if (!bill) throw new Error(`Missing bill ${billId}`);
  return cents(bill.totalAmount) - transactions(s).reduce((total, p) => total + (p.allocs || []).filter((a: any) => a.billId === billId).reduce((n: number, a: any) => n + cents(a.amount), 0), 0);
}
export interface PaymentAction { key: string; personIndex: number; mode: 'full-single' | 'partial' | 'multi-bill' | 'repeat'; cashier: 'cashier1' | 'cashier2'; channel: typeof channels[number]; allocs: {billId: string; amount: string}[] }
export function paymentPlan(s: PilotState): PaymentAction[] {
  const actions: PaymentAction[] = [];
  const add = (personIndex: number, mode: PaymentAction['mode'], allocs: PaymentAction['allocs']) => {
    const n = actions.length;
    actions.push({ key: `payment-${n + 1}`, personIndex, mode, cashier: n % 2 ? 'cashier2' : 'cashier1', channel: channels[n % 3], allocs });
  };
  const bills = (i: number) => s.periods.slice(0, 2).map(period => {
    const b = s.bills.find(b => b.waterAccountId === s.people[i].waterAccount.id && b.period === period);
    if (!b || cents(b.totalAmount) < 3) throw new Error(`Missing/zero bill for person ${i}, ${period}`);
    return b;
  });
  for (let i = 0; i < 10; i++) { const [b] = bills(i); add(i, 'full-single', [{ billId: b.id, amount: String(b.totalAmount) }]); }
  for (let i = 10; i < 15; i++) add(i, 'multi-bill', bills(i).map(b => ({ billId: b.id, amount: String(b.totalAmount) })));
  for (let i = 15; i < 20; i++) { const [b] = bills(i); add(i, 'partial', [{ billId: b.id, amount: String(Math.floor(cents(b.totalAmount) / 3)) }]); }
  for (let round = 0; round < 2; round++) for (let i = 15; i < 18; i++) {
    const [b] = bills(i); const third = Math.floor(cents(b.totalAmount) / 3);
    add(i, 'repeat', [{ billId: b.id, amount: String(round === 0 ? third : cents(b.totalAmount) - 2 * third) }]);
  }
  return actions;
}

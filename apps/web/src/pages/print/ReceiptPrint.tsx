import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api/client';
import dayjs from 'dayjs';

interface Pay {
  id: string; paymentNo?: string; amount?: number; payChannel?: string;
  createdAt?: string; cashierName?: string; customerName?: string; accountNo?: string;
  receiptNo?: string | null;
}
const yuan = (c?: number) => (c == null ? '—' : `¥${(c / 100).toFixed(2)}`);
const CH: Record<string, string> = { CASH: '现金', POS: 'POS机', BANK: '银行代扣', TRANSFER: '转账', OTHER: '其他' };

/** B1：收据打印模板（浏览器打印） */
export default function ReceiptPrint() {
  const { id } = useParams();
  const [p, setP] = useState<Pay | null>(null);
  useEffect(() => {
    api.get<Pay>(`/payments/${id}`).then((r) => {
      setP(r.data);
      setTimeout(() => window.print(), 400);
    });
  }, [id]);
  if (!p) return <p>加载中…</p>;
  return (
    <div style={{ width: 340, margin: '24px auto', fontFamily: 'SimSun, serif', fontSize: 13, lineHeight: 1.9 }}>
      <h3 style={{ textAlign: 'center', margin: '8px 0' }}>供水收费收据</h3>
      <div>收据编号：{p.receiptNo ?? '—'}　　收款单号：{p.paymentNo ?? '—'}</div>
      <div>户号/客户：{p.accountNo ?? '—'} {p.customerName ?? ''}</div>
      <div style={{ borderTop: '1px solid #333', margin: '6px 0' }} />
      <div>收费金额：<b style={{ fontSize: 16 }}>{yuan(p.amount)}</b></div>
      <div>收费方式：{CH[p.payChannel ?? ''] ?? p.payChannel ?? '—'}</div>
      <div>收款时间：{p.createdAt ? dayjs(p.createdAt).format('YYYY-MM-DD HH:mm') : '—'}</div>
      <div>收款员：{p.cashierName ?? '—'}</div>
      <div style={{ borderTop: '1px solid #333', margin: '6px 0' }} />
      <div style={{ textAlign: 'center', color: '#666', fontSize: 11 }}>本收据为系统打印凭证 · 补打有效</div>
    </div>
  );
}

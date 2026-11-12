import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api/client';
import dayjs from 'dayjs';

interface R { period?: string; reading?: number; qty?: number; readAt?: string; resultType?: string }
interface A { accountNo?: string; customerName?: string; addr?: string; meterNo?: string }

/** B1：抄表卡打印模板——近 12 期读数。 */
export default function ReadingCardPrint() {
  const { id } = useParams();
  const [a, setA] = useState<A>({});
  const [rows, setRows] = useState<R[]>([]);
  useEffect(() => {
    Promise.all([
      api.get<A>(`/water-accounts/${id}`),
      api.get<{ items?: R[] } | R[]>(`/meter-readings`, { params: { waterAccountId: id, take: 12 } }),
    ]).then(([ar, rr]) => {
      setA(ar.data);
      const list = Array.isArray(rr.data) ? rr.data : (rr.data.items ?? []);
      setRows(list);
      setTimeout(() => window.print(), 400);
    });
  }, [id]);
  return (
    <div style={{ width: 640, margin: '24px auto', fontFamily: 'SimSun, serif', fontSize: 13 }}>
      <h3 style={{ textAlign: 'center' }}>抄 表 卡</h3>
      <div>户号：{a.accountNo ?? '—'}　户名：{a.customerName ?? '—'}　表号：{a.meterNo ?? '—'}</div>
      <div>地址：{a.addr ?? '—'}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }} border={1}>
        <thead><tr><th>账期</th><th>读数</th><th>水量</th><th>抄表日期</th><th>类型</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ textAlign: 'center' }}>{r.period ?? '—'}</td>
              <td style={{ textAlign: 'right' }}>{r.reading ?? '—'}</td>
              <td style={{ textAlign: 'right' }}>{r.qty ?? '—'}</td>
              <td style={{ textAlign: 'center' }}>{r.readAt ? dayjs(r.readAt).format('YYYY-MM-DD') : '—'}</td>
              <td style={{ textAlign: 'center' }}>{r.resultType === 'NO_READ' ? '估抄' : '实抄'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ textAlign: 'center', color: '#666', fontSize: 11, marginTop: 8 }}>抄表卡 · 系统打印</p>
    </div>
  );
}

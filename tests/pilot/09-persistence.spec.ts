import {test,expect} from './helpers/test';
import {load,save} from './helpers/state';
import {db} from './helpers/db';
import {login,evidence} from './helpers/ui';
test('P15 persistent ledger crosscheck after UI business operations',async({page},info)=>{
 const s=load();test.skip(!s.stages.payment||!s.stages.reconciliation||!s.stages.meterChange||!s.stages.management||!s.stages.reports,'Required business stages unavailable');
 const snapshot=await db(async p=>{
  const accountIds=s.people.map(x=>x.waterAccount.id),customerIds=[...new Set(s.people.map(x=>x.customer.id))];
  const bills=await p.bill.findMany({where:{waterAccountId:{in:accountIds}}});
  const payments=await p.payment.findMany({where:{settleAccountId:{in:[...new Set(s.people.map(x=>x.settleAccount.id))]}}});
  const settlements=await p.consumptionSettlement.findMany({where:{waterAccountId:{in:accountIds}}});
  const installations=await p.meterInstallation.findMany({where:{waterAccountId:{in:accountIds}}});
  const readings=await p.meterReading.count({where:{installationId:{in:installations.map((x:any)=>x.id)}}});
  return {customerCount:await p.customer.count({where:{id:{in:customerIds}}}),accountCount:await p.waterAccount.count({where:{id:{in:accountIds}}}),readings,settlements:JSON.parse(JSON.stringify(settlements)),bills:JSON.parse(JSON.stringify(bills,(_k,v)=>typeof v==='bigint'?v.toString():v)),payments:JSON.parse(JSON.stringify(payments,(_k,v)=>typeof v==='bigint'?v.toString():v)),installations};
 });
 expect(snapshot.customerCount).toBe(40);expect(snapshot.accountCount).toBe(43);expect(snapshot.readings).toBe(92);
 for(const period of s.periods.slice(0,2)){expect(snapshot.settlements.filter((x:any)=>x.period===period&&x.status==='FINAL')).toHaveLength(43);expect(snapshot.bills.filter((x:any)=>x.period===period&&x.billKind==='NORMAL')).toHaveLength(43);}
 expect(snapshot.bills.filter((x:any)=>x.billKind==='ADJUSTMENT')).toHaveLength(1);expect(snapshot.bills.reduce((n:number,b:any)=>n+Number(b.totalAmount),0)).toBe(691500);
 expect(snapshot.payments).toHaveLength(28);expect(snapshot.payments.filter((p:any)=>Number(p.amount)<0)).toHaveLength(2);
 expect(snapshot.payments.reduce((n:number,p:any)=>n+Number(p.amount),0)).toBe([...s.payments,...s.reversals].reduce((n,p)=>n+Number(p.amount),0));
 expect(snapshot.installations).toHaveLength(45);expect(snapshot.installations.filter((x:any)=>x.status==='ACTIVE')).toHaveLength(43);expect(snapshot.installations.filter((x:any)=>x.status==='REMOVED')).toHaveLength(2);
 s.persistedSnapshot=snapshot;s.stages.persistence=true;save(s);await login(page);await evidence(page,info,'durable-ledger',snapshot);
});

import {test,expect} from './helpers/test';
import {load,save} from './helpers/state';
import {login,ready,button,response,row,main,selectPerson,evidence} from './helpers/ui';
import {planAndRead,qcPeriod,settleOne} from './helpers/workflow';
test('P10 three recovery actual readings and positive/negative reconciliations',async({page},info)=>{
 let s=load();test.skip(!s.stages.billing,'Two periods billing unavailable');await planAndRead(page,s.periods[2],true);await qcPeriod(page,s.periods[2]);await login(page);
 for(const p of s.people.filter(p=>p.group==='F')){
  s=load();s.reconciliations??=[];if(s.reconciliations.some((r:any)=>r.waterAccountId===p.waterAccount.id))continue;
  if(p.index!==38)await settleOne(page,p,s.periods[2],false);
  s=load();s.reconciliations??=[];await page.goto('/settlement/reconciliations');await ready(page);await page.getByRole('button',{name:'发起补差'}).click();const d=page.getByRole('dialog',{name:'发起补差'});await selectPerson(page,d,p);
  const result=await response(page,'/reconciliations',()=>button(d,'发起').click());s.reconciliations.push(result);if(result.adjustmentBill&&!s.bills.some(b=>b.id===result.adjustmentBill.id))s.bills.push(result.adjustmentBill);save(s);
  expect(Number(result.actualTotalUsage)).toBe([80,55,90][p.index-37]);expect(Number(result.previouslySettledUsage)).toBe(65);expect(Number(result.remainderUsage)).toBe([15,-10,25][p.index-37]);expect(result.status).toBe(p.index===38?'APPLIED':'ABSORBED');
  if(p.index===38)expect(Number(result.adjustmentAmountCent)).toBe(-3000);
  await expect(row(page,p.waterAccount.accountNo)).toBeVisible();await button(row(page,p.waterAccount.accountNo),'详情').click();await evidence(page,info,'reconciliation-'+p.index,result);
 }
 s=load();s.stages.reconciliation=true;save(s);
});

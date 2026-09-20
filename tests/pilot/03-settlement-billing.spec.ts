import {test,expect} from './helpers/test';
import {load,save} from './helpers/state';
import {login,ready,button,date,response,row,main,month,evidence} from './helpers/ui';
import {planAndRead,qcPeriod,settleOne} from './helpers/workflow';
for(let periodIndex=0;periodIndex<2;periodIndex++){
 test(`P0${6+periodIndex*2} period ${periodIndex+1} settlements and final review`,async({page},info)=>{
  let s=load();test.skip(!s.stages.firstQc,'First QC unavailable');if(periodIndex===1){await planAndRead(page,s.periods[1]);await qcPeriod(page,s.periods[1]);}
  await login(page);s=load();for(const p of s.people){await settleOne(page,p,s.periods[periodIndex]);console.log('PILOT settlement',s.periods[periodIndex],p.index);}
  s=load();s.stages['settlement'+periodIndex]=true;save(s);await page.reload();await ready(page);await expect(main(page)).toContainText('已终审');await evidence(page,info,'settlement-'+periodIndex);
 });
 test(`P0${7+periodIndex*2} period ${periodIndex+1} UI billing 43 bills exact cents`,async({page},info)=>{
  const s=load();test.skip(!s.stages['settlement'+periodIndex],'Settlements unavailable');s.runs??={};const period=s.periods[periodIndex];await login(page);await page.goto('/billing/runs');await ready(page);await date(main(page).getByPlaceholder('账期',{exact:true}),month(period));
  if(!s.runs[period]){await page.getByRole('button',{name:'新建开账批次'}).click();const d=page.getByRole('dialog',{name:'新建开账批次'});await date(d.getByLabel('账期',{exact:true}),month(period));s.runs[period]=await response(page,'/billing-runs',()=>button(d,'生成').click());save(s);}
  let run=s.runs[period];expect(run.bills).toHaveLength(43);
  if(run.status!=='POSTED'){await button(row(page,month(period)),'执行开账').click();run=await response(page,`/billing-runs/${run.id}/post`,()=>button(page.getByRole('tooltip'),'执行').click());s.runs[period]=run;save(s);}
  expect(run.status).toBe('POSTED');expect(run.successCount).toBe(43);expect(run.failedCount).toBe(0);
  for(const bill of run.bills){const p=s.people.find(p=>p.waterAccount.id===bill.waterAccountId);expect(p).toBeTruthy();const usage=p.group==='F'?(periodIndex===0?30:35):20;expect(Number(bill.totalAmount)).toBe(usage*p.price*100);if(!s.bills.some(b=>b.id===bill.id))s.bills.push(bill);}
  s.stages['billing'+periodIndex]=true;if(periodIndex===1)s.stages.billing=true;save(s);await expect(row(page,month(period))).toContainText('已过账');await evidence(page,info,'billing-'+periodIndex,run);
 });
}

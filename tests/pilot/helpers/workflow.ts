import type {Page,TestInfo} from '@playwright/test';
import {expect,measure} from './test';
import {load,save} from './state';
import {login,ready,button,date,choose,response,row,main,month,selectPerson,evidence} from './ui';
export async function planAndRead(page:Page,period:string,recovery=false){
 const s=load();
 for(let i=0;i<3;i++){
  const book=s.books[i],key=period+'-'+i;
  await login(page);await page.goto('/metering/plans');await ready(page);await date(main(page).getByPlaceholder('账期',{exact:true}),month(period));
  if(!s.plans[key]){
   await button(main(page),'生成计划').click();const d=page.getByRole('dialog',{name:'生成抄表计划'});
   await choose(page,d.getByText('搜索抄表册名称',{exact:true}),`${book.name}（${book.bookNo}）`,book.name);
   await date(d.getByLabel('账期',{exact:true}),month(period));await date(d.getByLabel('计划抄表日期',{exact:true}),month(period)+(recovery?'-18':'-28'));
   s.plans[key]=await response(page,'/reading-plans/generate',()=>button(d,'生成').click());save(s);
  }
  if(!s.plans[key].started){await response(page,`/reading-plans/${s.plans[key].id}/start`,()=>button(row(page,book.name).filter({has:page.getByRole('cell',{name:month(period),exact:true})}),'开始').click());s.plans[key].started=true;save(s);}
  const reader=s.roles[i===1?'reader2':'reader1'];await login(page,reader.login,'Pilot12345');await page.goto('/metering/plans');await ready(page);await date(main(page).getByPlaceholder('账期',{exact:true}),month(period));
  await button(row(page,book.name).filter({has:page.getByRole('cell',{name:month(period),exact:true})}),'明细').click();
  for(const p of s.people.filter(x=>x.bookIndex===i&&(!recovery||x.group==='F'))){
   const rk=period+'-'+p.index;if(s.readings[rk])continue;
   await measure(page,'reading-'+rk,async()=>{
    const dr=page.getByRole('dialog');await button(dr.getByRole('row').filter({hasText:p.waterAccount.accountNo}),'录入').click();
    const d=page.getByRole('dialog',{name:/抄表录入/});const noRead=!recovery&&['B','F'].includes(p.group);
    if(noRead){await d.getByText('未抄见',{exact:true}).click();await choose(page,d.getByLabel('未抄见原因',{exact:true}),p.group==='F'?'锁闭无法入户':['锁闭无法入户','锁闭无法入户','表井积水','表坏','其他'][p.index-20]);}
    else await d.getByLabel('表码读数').fill(String(recovery?[1080,1055,1090][p.index-37]:period===s.periods[0]?20:40));
    await date(d.getByLabel('抄表日期',{exact:true}),month(period)+(recovery?'-18':'-28'));
    s.readings[rk]=await response(page,'/meter-readings',()=>button(d,'提交').click());s.readings[rk].personIndex=p.index;save(s);
    await expect(page.getByRole('dialog').getByRole('row').filter({hasText:p.waterAccount.accountNo})).toContainText(noRead?'未抄见':'已抄');
   });
  }
  await page.reload();await ready(page);await expect(row(page,book.name).filter({has:page.getByRole('cell',{name:month(period),exact:true})})).toBeVisible();
 }
}
export async function qcPeriod(page:Page,period:string){
 const s=load();await login(page,s.roles.reviewer.login,'Pilot12345');await page.goto('/metering/readings');await ready(page);
 await date(main(page).getByPlaceholder('账期',{exact:true}),month(period));
 for(const [key,r] of Object.entries(s.readings).filter(([k])=>k.startsWith(period))){
  if(r.passed)continue;
  // Visible installation filter avoids accidental QC of other Pilot data or paginated rows.
  await main(page).getByPlaceholder('表计安装 ID',{exact:true}).fill(r.installationId);
  await Promise.all([page.waitForResponse(res=>new URL(res.url()).pathname==='/api/meter-readings'&&new URL(res.url()).searchParams.get('installationId')===r.installationId),main(page).getByPlaceholder('表计安装 ID',{exact:true}).press('Enter')]);await ready(page);await expect(button(main(page),'通过')).toHaveCount(1);
  await response(page,`/meter-readings/${r.id}/qc`,()=>button(main(page),'通过').click());
  r.passed=true;save(s);await expect(main(page)).toContainText('质检通过');
 }
}
export async function settleOne(page:Page,p:any,period:string,finalize=true){
 const s=load(),key=period+'-'+p.index;await page.goto('/settlement/list');await ready(page);await date(main(page).getByPlaceholder('账期',{exact:true}),month(period));
 if(!s.settlements[key]){
  await button(main(page),'生成结算').click();const d=page.getByRole('dialog',{name:'生成结算（草稿）'});await selectPerson(page,d,p);await date(d.getByLabel('账期',{exact:true}),month(period));
  if(period!==s.periods[2]&&['B','F'].includes(p.group)){await d.getByLabel('预估用量（可空）',{exact:true}).fill(String(p.group==='F'?(period===s.periods[0]?30:35):20));await d.getByLabel('预估原因',{exact:true}).fill('Pilot 未抄见人工核定估水');}
  s.settlements[key]=await response(page,'/consumption-settlements',()=>button(d,'生成').click());save(s);
  if(period!==s.periods[2])expect(Number(s.settlements[key].totalUsageQty)).toBe(p.group==='F'?(period===s.periods[0]?30:35):20);
 }
 if(finalize&&!s.settlements[key].final){
  // Scope by customer to avoid repeated account numbers across pages and periods.
  await choose(page,main(page).getByText('按客户过滤',{exact:true}),`${p.customer.name}（${p.customer.customerNo}）`,p.customer.name);
  await button(row(page,p.waterAccount.accountNo),'终审').click();await response(page,`/consumption-settlements/${s.settlements[key].id}/finalize`,()=>button(page.getByRole('tooltip'),'终审').click());
  s.settlements[key].final=true;save(s);await expect(row(page,p.waterAccount.accountNo)).toContainText('已终审');
 }
 return s.settlements[key];
}

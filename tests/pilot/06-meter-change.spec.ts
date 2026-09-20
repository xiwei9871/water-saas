import {test,expect,measure} from './helpers/test';
import {load,save} from './helpers/state';
import {login,ready,button,date,choose,response,row,main,selectPerson,evidence} from './helpers/ui';
test('P12 two UI meter removals and replacement installations retain history',async({page},info)=>{
 const s=load();test.skip(!s.stages.billing,'Two billing periods unavailable');s.meterChanges??=[];await login(page);
 for(const p of s.people.filter(p=>[30,31].includes(p.index))){
  let swap=s.meterChanges.find((x:any)=>x.personIndex===p.index);if(!swap){swap={personIndex:p.index};s.meterChanges.push(swap);save(s);}if(swap.verified)continue;
  await page.goto('/customer/meters');await ready(page);
  await measure(page,'meter-swap-'+p.index,async()=>{
   if(!swap.meter){await button(main(page),'登记水表').click();const d=page.getByRole('dialog',{name:'登记水表'});swap.meter=await response(page,'/meters',()=>button(d,'保存').click());save(s);}
   await selectPerson(page,main(page),p,'先选客户','按水表户过滤');
   if(!swap.removal){const old=main(page).getByRole('row').filter({hasText:p.meter.meterNo}).filter({hasText:p.waterAccount.accountNo});await button(old,'拆除').click();const d=page.getByRole('dialog',{name:/拆表/});await d.getByLabel('拆除读数').fill('40');await date(d.getByLabel('拆表日期'),'2026-09-19');swap.removal=await response(page,`/meter-installations/${p.installation.id}/remove`,()=>button(d,'确认拆除').click());save(s);}
   if(!swap.installation){await button(main(page),'装表').click();const d=page.getByRole('dialog',{name:'装表',exact:true});await selectPerson(page,d,p);await choose(page,d.locator('.ant-form-item').filter({hasText:'水表（仅可用表可安装）'}).getByRole('combobox'),swap.meter.meterNo,swap.meter.meterNo);await d.getByLabel('初始读数',{exact:true}).fill('0');await date(d.getByLabel('装表日期'),'2026-09-19');await choose(page,d.getByLabel('装表原因'),'换表');swap.installation=await response(page,'/meter-installations',()=>button(d,'确认装表').click());save(s);}
   expect(swap.removal.status).toBe('REMOVED');expect(swap.installation.status).toBe('ACTIVE');expect(swap.installation.reason).toBe('REPLACE');
   await page.reload();await ready(page);await selectPerson(page,main(page),p,'先选客户','按水表户过滤');
   await expect(main(page).getByRole('row').filter({hasText:p.meter.meterNo}).filter({hasText:p.waterAccount.accountNo})).toContainText('已拆除');await expect(main(page).getByRole('row').filter({hasText:swap.meter.meterNo}).filter({hasText:p.waterAccount.accountNo})).toContainText('在用');swap.verified=true;save(s);await evidence(page,info,'meter-swap-'+p.index,swap);
  });
 }
 s.stages.meterChange=true;save(s);
});

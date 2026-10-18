import {test,expect,measure} from './helpers/test';
import {load,save,record} from './helpers/state';
import {login,ready,button,row,main,selectPerson,evidence,month} from './helpers/ui';
import {money} from './helpers/payment';
test('P14 management finds multi-account customer and five historical debt households',async({page},info)=>{
 const s=load();test.skip(!s.stages.billing,'Billing unavailable');await login(page);await page.goto('/customer/customers');await ready(page);
 await measure(page,'find-company-three-accounts',async()=>{
  await main(page).getByPlaceholder('按名称搜索',{exact:true}).fill(s.people[1].customer.name);await main(page).getByPlaceholder('按名称搜索',{exact:true}).press('Enter');await button(row(page,s.people[1].customer.name),'详情').click();
  const d=page.getByRole('dialog');for(const p of s.people.filter(p=>p.customer.id===s.people[1].customer.id))await expect(d).toContainText(p.waterAccount.accountNo);await evidence(page,info,'company-three-accounts');
 });
 for(const p of s.people.filter(p=>p.group==='C')){
  await page.goto('/billing/bills');await ready(page);await selectPerson(page,main(page),p,'先选客户（联动用水户）','按用水户过滤');
  for(const period of s.periods.slice(0,2)){const bill=s.bills.find(b=>b.waterAccountId===p.waterAccount.id&&b.period===period);const br=main(page).getByRole('row').filter({has:page.getByRole('cell',{name:month(period),exact:true})});await expect(br).toContainText(money(bill.totalAmount));await expect(br).toContainText('已出账');}
 }
 await evidence(page,info,'historical-debt');s.stages.management=true;save(s);
});

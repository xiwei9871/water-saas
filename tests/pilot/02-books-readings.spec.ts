import {test,expect,measure} from './helpers/test';
import {load,save,record} from './helpers/state';
import {login,ready,button,choose,response,row,main,selectPerson,evidence,date,month} from './helpers/ui';
import {planAndRead,qcPeriod} from './helpers/workflow';
test('P03 three reading books, ordered members and remove/rejoin',async({page},info)=>{
 const s=load();test.skip(!s.stages.onboard,'Onboard unavailable');await login(page);
 for(let i=0;i<3;i++){
  await page.goto('/metering/books');await ready(page);
  if(!s.books[i]){
   await page.getByRole('button',{name:'新建抄表册'}).click();const d=page.getByRole('dialog',{name:'新建抄表册'});
   await d.getByLabel('册名').fill(s.prefix+'-'+['城东一册','城东二册','商业用户册'][i]);
   await choose(page,d.locator('.ant-form-item').filter({hasText:'所属组织'}).getByRole('combobox'),'成都水务公司');
   const staff=s.roles[i===1?'reader2':'reader1'];await choose(page,d.locator('.ant-form-item').filter({hasText:'默认抄表员'}).getByRole('combobox'),`${staff.name}（${staff.login}）`);
   s.books[i]={...await response(page,'/reading-books',()=>button(d,'保存').click()),members:[]};save(s);
  }
  const book=s.books[i];await button(row(page,book.name),'成员').click();const dr=page.getByRole('dialog');
  for(const p of s.people.filter(p=>p.bookIndex===i)){
   if(book.members.includes(p.index))continue;
   await measure(page,'book-member-'+p.index,async()=>{await selectPerson(page,dr,p,'先选客户');await dr.getByPlaceholder('顺序(可空)').fill(String(p.index+1));await response(page,`/reading-books/${book.id}/meters`,()=>button(dr,'加入').click());});
   book.members.push(p.index);save(s);await expect(dr.getByRole('row').filter({hasText:p.waterAccount.accountNo})).toBeVisible();
  }
  await expect(dr).toContainText(`共 ${book.members.length} 户`);
  if(i===0&&!book.rejoined){const p=s.people[0];await button(dr.getByRole('row').filter({hasText:p.waterAccount.accountNo}),'移出').click();await response(page,`/reading-books/${book.id}/meters/${p.waterAccount.id}`,()=>button(page.getByRole('tooltip'),'移出').click(),'DELETE');book.members=book.members.filter((n:number)=>n!==0);save(s);
   await selectPerson(page,dr,p,'先选客户');await dr.getByPlaceholder('顺序(可空)').fill('1');await response(page,`/reading-books/${book.id}/meters`,()=>button(dr,'加入').click());book.members.push(0);book.rejoined=true;save(s);
  }
 }
 s.stages.books=true;save(s);await evidence(page,info,'book-members');
});
test('P04 first period: two readers, 35 actual and 8 NO_READ',async({page},info)=>{
 const s=load();test.skip(!s.stages.books,'Books unavailable');await planAndRead(page,s.periods[0]);const n=load();expect(Object.keys(n.readings).filter(k=>k.startsWith(s.periods[0]))).toHaveLength(43);n.stages.firstRead=true;save(n);await evidence(page,info,'first-reading');
});
test('P05 reviewer QC first period without entry/import privileges',async({page},info)=>{
 const s=load();test.skip(!s.stages.firstRead,'Readings unavailable');await login(page,s.roles.reviewer.login,'Pilot12345');await page.goto('/metering/readings');await ready(page);
 const identity=await page.evaluate(async()=>{const r=await fetch('/api/auth/me',{headers:{Authorization:'Bearer '+localStorage.getItem('water-saas.accessToken')}});return r.json();});expect(JSON.stringify(identity)).toContain('metering:qc');
 await expect(button(main(page),'批量导入')).toHaveCount(0);await expect(button(main(page),'更正')).toHaveCount(0);
 await qcPeriod(page,s.periods[0]);const n=load();n.stages.firstQc=true;save(n);await evidence(page,info,'reviewer-qc');
});

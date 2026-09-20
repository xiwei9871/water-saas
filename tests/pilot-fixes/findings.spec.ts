import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {test,expect} from '../uat/helpers/console';
import {login,ready,main,button,date,choose,month,response,evidence} from '../pilot/helpers/ui';
const req=createRequire(resolve('apps/api/package.json'));const {PrismaClient}=req('@prisma/client');
const s=JSON.parse(readFileSync('artifacts/pilot/p20260919a/state.json','utf8'));
const period='208801';
const qcIds:Record<string,string>={};
test.beforeAll(async()=>{
 const p=new PrismaClient({datasourceUrl:'postgresql://postgres:postgres@localhost:5432/water_pilot_fix_v012'});
 try{const [database]=await p.$queryRawUnsafe('SELECT current_database() AS name');expect(database.name).toBe('water_pilot_fix_v012');
  const role=await p.role.findUniqueOrThrow({where:{tenantId_code:{tenantId:s.tenant.id,code:'reviewer'}}});
  const reader=await p.staff.findUniqueOrThrow({where:{id:s.roles.reader1.id}});
  let org=await p.orgUnit.findFirst({where:{tenantId:s.tenant.id,name:'Pilot修复范围外组织'}});
  if(!org)org=await p.orgUnit.create({data:{tenantId:s.tenant.id,name:'Pilot修复范围外组织',type:'BRANCH'}});
  const outsider=await p.staff.upsert({where:{tenantId_login:{tenantId:s.tenant.id,login:'pilot-fix-outside'}},update:{},create:{tenantId:s.tenant.id,orgUnitId:org.id,login:'pilot-fix-outside',name:'范围外复核员',passwordHash:reader.passwordHash,status:'ACTIVE'}});
  await p.staffRole.upsert({where:{staffId_roleId:{staffId:outsider.id,roleId:role.id}},update:{},create:{tenantId:s.tenant.id,staffId:outsider.id,roleId:role.id}});
  for(const [i,action] of ['pass','reject','review'].entries()){
   const person=s.people[i];const remark='pilot-fix-QC-'+action;
   let r=await p.meterReading.findFirst({where:{tenantId:s.tenant.id,remark,qcStatus:'PENDING'}});
   if(!r)r=await p.meterReading.create({data:{tenantId:s.tenant.id,installationId:person.installation.id,meterId:person.meter.id,period,readDate:new Date('2088-01-01'),resultType:'ACTUAL',readingValue:50,qcStatus:'PENDING',source:'WEB',operatorId:s.roles.reader1.id,remark}});
   qcIds[action]=r.id;
  }
 }finally{await p.$disconnect();}
});
test('PILOT-001 choose known category and allow custom value with associated label',async({page},info)=>{
 await login(page);await page.goto('/customer/onboard');await page.getByLabel('客户名称',{exact:true}).fill('类别选择验证（不提交）');await button(main(page),'下一步').click();await button(main(page),'下一步').click();
 const category=page.getByLabel('用水类别',{exact:true});await expect(category).toHaveAttribute('role','combobox');await category.fill('居民');await page.locator('.ant-select-dropdown:visible').getByText(s.tariffs[0].category,{exact:true}).filter({visible:true}).click();await expect(category).toHaveValue(s.tariffs[0].category);
 await category.fill('自定义测试类别');await category.press('Tab');await expect(category).toHaveValue('自定义测试类别');await category.fill('');await button(main(page),'下一步').click();await expect(main(page)).toContainText('请输入用水类别');await evidence(page,info,'category-picker');
});
for(const [action,label,status] of [['pass','通过','质检通过'],['reject','驳回','质检驳回'],['review','复核','人工复核']]){
 test(`PILOT-002 reviewer QC ${action} without general write`,async({page},info)=>{
  await login(page,s.roles.reviewer.login,'Pilot12345');await page.goto('/metering/readings');await ready(page);await date(main(page).getByPlaceholder('账期',{exact:true}),month(period));
  const filter=main(page).getByPlaceholder('表计安装 ID',{exact:true});await filter.fill(s.people[['pass','reject','review'].indexOf(action)].installation.id);await filter.press('Enter');
  const target=main(page).locator(`tr[data-row-key="${qcIds[action]}"]`);await expect(button(target,label)).toBeVisible();await response(page,`/meter-readings/${qcIds[action]}/qc`,()=>button(target,label).click());await expect(target).toContainText(status);await expect(button(main(page),'更正')).toHaveCount(0);await expect(button(main(page),'批量导入')).toHaveCount(0);await evidence(page,info,'qc-'+action);
 });
}
test('PILOT-002 reviewer prohibited writes and cashier QC stay 403',async({page,audit})=>{
 await login(page,s.roles.reviewer.login,'Pilot12345');
 for(const path of ['/meter-readings','/meter-readings/import',`/meter-readings/${qcIds.pass}/supersede`,'/payments','/iam/staff']){
  audit.allow('/api'+path,403,'POST');const status=await page.evaluate(async path=>{const r=await fetch('/api'+path,{method:'POST',headers:{Authorization:'Bearer '+localStorage.getItem('water-saas.accessToken'),'Content-Type':'application/json'},body:'{}'});await r.json();return r.status;},path);expect(status).toBe(403);
 }
 await login(page,s.roles.cashier1.login,'Pilot12345');const path=`/meter-readings/${qcIds.pass}/qc`;audit.allow('/api'+path,403,'POST');expect(await page.evaluate(async path=>{const r=await fetch('/api'+path,{method:'POST',headers:{Authorization:'Bearer '+localStorage.getItem('water-saas.accessToken'),'Content-Type':'application/json'},body:JSON.stringify({action:'pass'})});await r.json();return r.status;},path)).toBe(403);
});
for(const key of ['accountNo','customerName','addr'])test(`PILOT-003 search ${key}, business identity and readable staff`,async({page},info)=>{
 const person=s.people[12],term=key==='accountNo'?person.waterAccount.accountNo:key==='customerName'?person.customer.name:person.addr;
 await login(page,s.roles.reviewer.login,'Pilot12345');await page.goto('/metering/readings');await ready(page);
 const search=main(page).getByPlaceholder('搜索户号、客户或地址',{exact:true});await search.fill(term);const result=await response(page,'/meter-readings',()=>search.press('Enter'),'GET');
 expect(result.length).toBeGreaterThan(0);for(const r of result){expect(r.account.accountNo).toBe(person.waterAccount.accountNo);expect(r.account.customerName).toBe(person.customer.name);expect(r.operatorName).toMatch(/Pilot抄表员/);expect(JSON.stringify(r)).not.toContain('passwordHash');}
 await expect(main(page).getByRole('cell',{name:person.waterAccount.accountNo,exact:true}).first()).toBeVisible();await expect(main(page)).toContainText(person.customer.name);await expect(main(page)).toContainText(person.addr);await expect(main(page)).toContainText('Pilot抄表员');
 await page.setViewportSize({width:1024,height:768});expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(2);await evidence(page,info,'search-'+key,result);
});
test('PILOT-003 foreign tenant cannot query Pilot identities/categories',async({page})=>{
 await login(page);await page.goto('/login');await page.evaluate(()=>localStorage.clear());await page.reload();await page.getByLabel('租户代码').fill('xh-water');await page.getByLabel('账号',{exact:true}).fill('admin');await page.getByLabel('密码',{exact:true}).fill('admin123');await button(page,'登录').click();await expect(page.getByRole('heading',{name:'工作台'})).toBeVisible();
 const result=await page.evaluate(async term=>{const headers={Authorization:'Bearer '+localStorage.getItem('water-saas.accessToken')};const a=await fetch('/api/meter-readings?q='+encodeURIComponent(term),{headers});const b=await fetch('/api/water-accounts/usage-categories',{headers});return {readings:await a.json(),categoryStatus:b.status,categories:await b.json()};},s.people[0].customer.name);
 expect(result.readings).toEqual([]);expect(result.categoryStatus).toBe(200);expect(result.categories).not.toContain(s.tariffs[0].category);
});
test('PILOT-004 negative net billed suppresses misleading ratio and explains periods',async({page},info)=>{
 await login(page);await page.goto('/report/recovery-rate');await ready(page);await date(main(page).getByPlaceholder('请选择月份',{exact:true}),'2026-09');const result=await response(page,'/reports/recovery-rate',()=>button(main(page),'查询').click(),'GET');
 expect(result.billed).toBe('-3000');expect(result.rate).toBe('-58.4443');await expect(main(page)).toContainText('净应收为负，本期回收率不适用');await expect(main(page)).toContainText('实收按收款日期统计');await expect(main(page)).not.toContainText('-5844.43%');await expect(main(page)).toContainText('¥-30.00');await evidence(page,info,'negative-recovery',result);
});
test('PILOT-004 cumulative positive ratio stays 25.36 percent',async({page})=>{
 await login(page);await page.goto('/report/recovery-rate');await ready(page);await date(main(page).getByPlaceholder('请选择月份',{exact:true}),'2026-07');await date(main(page).getByPlaceholder('截止月（累计口径，可空）',{exact:true}),'2026-09');await response(page,'/reports/recovery-rate',()=>button(main(page),'查询').click(),'GET');await expect(main(page)).toContainText('25.36%');
});
test('PILOT-004 zero net billed retains explanation',async({page})=>{
 await login(page);await page.goto('/report/recovery-rate');await ready(page);await date(main(page).getByPlaceholder('请选择月份',{exact:true}),'2088-02');await response(page,'/reports/recovery-rate',()=>button(main(page),'查询').click(),'GET');await expect(main(page)).toContainText('应收为 0，回收率无意义');
});

test('PILOT-002 QC still rejects out-of-scope book and cross-tenant reading',async({page,audit})=>{
 const target=Object.values(s.readings)[0] as any;const path=`/meter-readings/${target.id}/qc`;
 await login(page,'pilot-fix-outside','Pilot12345');audit.allow('/api'+path,403,'POST');
 const call=()=>page.evaluate(async path=>{const r=await fetch('/api'+path,{method:'POST',headers:{Authorization:'Bearer '+localStorage.getItem('water-saas.accessToken'),'Content-Type':'application/json'},body:JSON.stringify({action:'pass'})});return {status:r.status,body:await r.json()};},path);
 expect((await call()).status).toBe(403);
 await page.goto('/login');await page.evaluate(()=>localStorage.clear());await page.reload();await page.getByLabel('租户代码').fill('xh-water');await page.getByLabel('账号',{exact:true}).fill('admin');await page.getByLabel('密码',{exact:true}).fill('admin123');await button(page,'登录').click();await expect(page.getByRole('heading',{name:'工作台'})).toBeVisible();audit.allow('/api'+path,404,'POST');expect((await call()).status).toBe(404);
});

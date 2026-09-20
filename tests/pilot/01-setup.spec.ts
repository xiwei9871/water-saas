import { test,expect,measure } from './helpers/test';
import { load,save,record } from './helpers/state';
import { db,bcrypt } from './helpers/db';
import { login,ready,button,date,choose,response,row,main,evidence,personLabel } from './helpers/ui';

test('P00 persistent Pilot identity and six staff fixtures',async({page},info)=>{
 const s=load();
 await db(async p=>{
  const tenant=await p.tenant.findUniqueOrThrow({where:{code:'cd-water'}});
  const org=await p.orgUnit.findFirstOrThrow({where:{tenantId:tenant.id,type:'COMPANY'}});
  s.tenant=tenant;s.org=org;
  const hash=await bcrypt.hash('Pilot12345',10);
  for(const [key,roleCode,name] of [['reader1','reader','Pilot抄表员1'],['reader2','reader','Pilot抄表员2'],['cashier1','cashier','Pilot收费员1'],['cashier2','cashier','Pilot收费员2'],['reviewer','reviewer','Pilot复核员']]){
   const role=await p.role.findUniqueOrThrow({where:{tenantId_code:{tenantId:tenant.id,code:roleCode}}});
   const accountLogin=s.runId+'-'+key;
   const staff=await p.staff.upsert({where:{tenantId_login:{tenantId:tenant.id,login:accountLogin}},update:{},create:{tenantId:tenant.id,orgUnitId:org.id,login:accountLogin,name,passwordHash:hash,status:'ACTIVE'}});
   await p.staffRole.upsert({where:{staffId_roleId:{staffId:staff.id,roleId:role.id}},update:{},create:{tenantId:tenant.id,staffId:staff.id,roleId:role.id}});
   s.roles[key]={id:staff.id,name:staff.name,login:staff.login};
  }
 });save(s);
 await login(page);
 const identity=await page.evaluate(async()=>{const r=await fetch('/api/auth/me',{headers:{Authorization:'Bearer '+localStorage.getItem('water-saas.accessToken')}});return r.json();});
 expect(JSON.stringify(identity)).toContain(s.tenant.id);
 s.stages.setup=true;save(s);await evidence(page,info,'pilot-identity',{tenantId:s.tenant.id,roles:s.roles});
});

test('P01 three Chinese usage categories and active tariffs through UI',async({page},info)=>{
 const s=load();test.skip(!s.stages.setup,'Setup unavailable');await login(page);
 for(let i=0;i<3;i++){
  if(s.tariffs[i]?.active)continue;
  if(s.tariffs[i]){await page.goto("/billing/tariffs");await ready(page);await button(row(page,s.prefix+"-T"+i),"激活").click();await response(page,`/tariff-plans/${s.tariffs[i].id}/activate`,()=>button(page.getByRole("tooltip"),"激活").click());s.tariffs[i].active=true;save(s);continue;}
  const name=['居民用水','商业用水','行政其他用水'][i];const category=name+'-'+s.runId;const price=[3,5,4][i];
  await page.goto('/billing/tariffs');await ready(page);await page.getByRole('button',{name:'新建资费方案'}).click();
  const d=page.getByRole('dialog',{name:'新建资费方案'});
  await d.getByLabel('编码',{exact:true}).fill(s.prefix+'-T'+i);await d.getByLabel('名称',{exact:true}).fill('Pilot'+name);
  await d.getByLabel('用水类别',{exact:true}).fill(category);await date(d.getByLabel('生效日期',{exact:true}),'2026-01-01');
  await choose(page,d.getByText('选择费用项（每组一套阶梯）',{exact:true}),'水费（WATER · 按量计价）');
  await d.getByPlaceholder('起始量',{exact:true}).fill('0');await d.getByPlaceholder('单价(元/m³)').fill(price.toFixed(6));
  const tariff=await response(page,'/tariff-plans',()=>button(d,'保存').click());
  s.tariffs[i]={...tariff,category,price};save(s);
  await button(row(page,s.prefix+'-T'+i),'激活').click();
  await response(page,`/tariff-plans/${tariff.id}/activate`,()=>button(page.getByRole('tooltip'),'激活').click());
  s.tariffs[i].active=true;save(s);await expect(row(page,s.prefix+'-T'+i)).toContainText('生效中');
 }
 expect(s.tariffs.every(t=>t.active)).toBeTruthy();s.stages.tariffs=true;save(s);await evidence(page,info,'three-tariffs');
});

test('P02 forty customers and forty-three water accounts via repeated UI onboarding',async({page},info)=>{
 const s=load();test.skip(!s.stages.tariffs,'Tariffs unavailable');await login(page);
 for(let i=s.people.length;i<43;i++){
  const reuse=i===40?s.people[0]:i>=41?s.people[1]:null;
  const group=i<20?'A':i<25?'B':i<30?'C':i<33?'D':i<37?'E':i<40?'F':'A';
  const tariff=s.tariffs[group==='F'?0:i%3];const addr=`城东试点小区${Math.floor(i/10)+1}栋${101+i}室`;
  const name=reuse?reuse.customer.name:`${s.prefix}-${group}${String(i+1).padStart(2,'0')}${i===1?'模拟公司':'模拟客户'}`;
  await page.goto('/customer/onboard');
  const result=await measure(page,'onboard-'+i,async()=>{
   if(reuse){await page.getByText('选择已有客户',{exact:true}).click();await choose(page,page.getByText('搜索客户名称',{exact:true}),personLabel(reuse),reuse.customer.name);}
   else {await page.getByLabel('客户名称',{exact:true}).fill(name);await page.getByLabel('联系地址',{exact:true}).fill(addr);if(i===1)await choose(page,page.getByLabel('客户类型',{exact:true}),'单位');}
   await page.getByRole('button',{name:'下一步'}).click();
   if(reuse){await page.getByText('选择已有结算户',{exact:true}).click();await choose(page,page.locator('.ant-form-item').filter({hasText:'已有结算户'}).getByRole('combobox'),`${reuse.settleAccount.name}（${reuse.settleAccount.settleNo}）`,reuse.settleAccount.name);}
   await page.getByRole('button',{name:'下一步'}).click();
   await page.getByLabel('用水类别',{exact:true}).fill(tariff.category);await page.getByLabel('用水地址',{exact:true}).fill(addr);
   await date(page.getByLabel('开户日期',{exact:true}),'2026-06-01');
   await page.getByRole('button',{name:'下一步'}).click();
   await page.getByLabel('装表初始读数').fill(group==='F'?'1000':'0');await date(page.getByLabel('装表日期',{exact:true}),'2026-06-01');
   return response(page,'/water-accounts/onboard',()=>page.getByRole('button',{name:'提交立户'}).click());
  });
  s.people.push({...result,index:i,group,category:tariff.category,price:tariff.price,addr,bookIndex:i%3});save(s);
  await expect(main(page)).toContainText(result.waterAccount.accountNo);console.log('PILOT onboard',i+1,result.waterAccount.accountNo);
 }
 expect(new Set(s.people.map(p=>p.customer.id)).size).toBe(40);expect(s.people).toHaveLength(43);
 // Three explicit historical anchor fixtures, not claimed as UI reading/QC coverage.
 await db(async p=>{
  const admin=await p.staff.findUniqueOrThrow({where:{tenantId_login:{tenantId:s.tenant.id,login:'admin'}}});
  for(const x of s.people.filter(x=>x.group==='F')){
   if(x.anchor)continue;
   x.anchor=await p.meterReading.create({data:{tenantId:s.tenant.id,installationId:x.installation.id,meterId:x.meter.id,period:'202606',readDate:new Date('2026-06-30'),resultType:'ACTUAL',readingValue:'1000',qcStatus:'PASSED',qcBy:admin.id,qcAt:new Date(),source:'WEB',operatorId:admin.id,remark:'PILOT historical anchor fixture; not a UI test'}});save(s);
  }
 });
 s.stages.onboard=true;save(s);await evidence(page,info,'onboard-final',{customers:40,waterAccounts:43,historicalAnchors:3});
});

import {chromium, expect} from '@playwright/test';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {routes} from '../tests/uat/helpers/routes';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const credentialsPath = process.env.WATER_LOGIN_FILE;
if (!credentialsPath) throw Error('WATER_LOGIN_FILE must name the protected deployment credentials JSON');
const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
const baseURL = process.env.WATER_SMOKE_URL ?? credentials.lanUrl;
if (![credentials.lanUrl, credentials.url].includes(baseURL)) throw Error('Unapproved credential destination');
// Prove the destination is our exact deployment before sending credentials.
const metadataResponse = await fetch(new URL('/release.json', baseURL));
expect(metadataResponse.status).toBe(200);
const metadata = await metadataResponse.json();
expect(metadata.commit).toBe(credentials.release);
const output = resolve(root, 'artifacts/pilot/deploy', new URL(baseURL).protocol === 'https:' ? 'public' : 'lan');
mkdirSync(output, {recursive:true});
const browser = await chromium.launch({channel:'chrome',args:['--no-proxy-server']});
const context = await browser.newContext({baseURL, locale:'zh-CN', viewport:{width:1440,height:900}});
const page = await context.newPage();
const errors: object[] = [];
const apiStatuses: object[] = [];
page.on('console', m => { if(m.type()==='error') errors.push({kind:'console',text:m.text()}); });
page.on('pageerror', e => errors.push({kind:'pageerror',text:e.message}));
page.on('requestfailed', r => errors.push({kind:'requestfailed',url:r.url(),error:r.failure()?.errorText}));
page.on('request', r => {
 if (['fetch','xhr'].includes(r.resourceType())) {
  const u=new URL(r.url());
  if(u.origin!==baseURL || !u.pathname.startsWith('/api/')) errors.push({kind:'proxy-bypass',url:r.url()});
 }
});
page.on('response', r => {
 if(r.url().includes('/api/')) apiStatuses.push({path:new URL(r.url()).pathname,status:r.status()});
 if(r.status()>=400) errors.push({kind:'http',url:r.url(),status:r.status()});
});
const passed: string[]=[];
try {
 await page.goto('/customer/onboard');
 await expect(page).toHaveURL(new URL('/login',baseURL).href);
 passed.push('unauthenticated route redirects to login');
 // Direct requests still go through the same deployed /api proxy.
 const denied=await context.request.get('/api/auth/me'); expect(denied.status()).toBe(401);
 for(const [tenant,login] of Object.entries(credentials.admin) as [string,{login:string,password:string}][]) {
  const old=await context.request.post('/api/auth/login',{data:{tenantCode:tenant,login:'admin',password:'admin123'}});
  expect(old.status(),tenant+' must reject seed password').toBe(401);
  const authenticated=await context.request.post('/api/auth/login',{data:{tenantCode:tenant,...login}});
  expect(authenticated.status()).toBe(201);
  passed.push(tenant+' rotated login succeeds; seed password denied');
 }
 const uiTenant = Object.keys(credentials.admin)[0];
 await page.getByLabel('租户代码').fill(uiTenant);
 await page.getByLabel('账号',{exact:true}).fill(credentials.admin[uiTenant].login);
 await page.getByLabel('密码',{exact:true}).fill(credentials.admin[uiTenant].password);
 await page.getByRole('button',{name:/^登\s*录$/}).click();
 await expect(page).toHaveURL(new URL('/customer/onboard',baseURL).href);
 await expect(page.getByRole('banner')).toContainText(uiTenant);
 passed.push('login returns to original requested page');
 await page.waitForLoadState('networkidle');
 for(const [,path,title] of routes) {
  await page.goto(path); await page.waitForLoadState('networkidle');
  await expect(page.getByRole('main').getByText(title,{exact:true}).first()).toBeVisible();
  const width=await page.evaluate(()=>({actual:document.documentElement.scrollWidth,limit:document.documentElement.clientWidth}));
  expect(width.actual).toBeLessThanOrEqual(width.limit+2);
  passed.push(path);
 }
 await page.goto('/'); await page.waitForLoadState('networkidle');
 await page.screenshot({path:resolve(output,'dashboard.png'),fullPage:true});
 expect(errors).toEqual([]);
 writeFileSync(resolve(output,'result.json'),JSON.stringify({origin:baseURL,commit:metadata.commit,browser:browser.version(),passed,errors,apiStatuses},null,2));
 console.log(JSON.stringify({origin:baseURL,commit:metadata.commit,checks:passed.length,unexpected:errors.length}));
} catch(e) {
 writeFileSync(resolve(output,'failure.json'),JSON.stringify({passed,errors,apiStatuses,message:String(e)},null,2));
 throw e;
} finally {await browser.close();}

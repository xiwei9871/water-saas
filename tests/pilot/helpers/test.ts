import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { BrowserAudit } from '../../uat/helpers/console';
import { record } from './state';
export const test=base.extend<{audit:BrowserAudit}>({audit:[async({page,browser},use,info)=>{
 const audit=new BrowserAudit(page);
 record("environment",{test:info.title,browser:browser.version(),channel:"chrome",date:new Date().toISOString()});
 await page.addInitScript(()=>{(window as any).__pilotActions={clicks:0,keys:0};document.addEventListener('click',()=>{(window as any).__pilotActions.clicks++},true);document.addEventListener('keydown',()=>{(window as any).__pilotActions.keys++},true)});
 await use(audit);await Promise.allSettled(audit.pending);
 await info.attach('browser-network',{body:JSON.stringify(audit.events,null,2),contentType:'application/json'});
 record('network',{test:info.title,events:audit.events,unexpected:audit.unexpected()});
 expect.soft(audit.unexpected(),'Unexpected browser/network events').toEqual([]);
 },{auto:true}]});
export {expect};
export async function measure<T>(page:Page,label:string,fn:()=>Promise<T>):Promise<T>{
 const before=await page.evaluate(()=>(window as any).__pilotActions||{clicks:0,keys:0});const start=Date.now();
 let navigated=false;const nav=(frame:any)=>{if(frame===page.mainFrame())navigated=true;};page.on('framenavigated',nav);
 let completed=false;
 try{const result=await fn();completed=true;return result;}finally{
  page.off('framenavigated',nav);
  const after=await page.evaluate(()=>(window as any).__pilotActions||{clicks:0,keys:0}).catch(()=>before);
  record('metrics',{label,automationMs:Date.now()-start,completed,clicks:navigated?null:Math.max(0,after.clicks-before.clicks),keys:navigated?null:Math.max(0,after.keys-before.keys),actionCountValid:!navigated,humanTiming:false});
 }
}

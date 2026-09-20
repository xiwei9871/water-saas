import { expect,type Page,type Locator } from '@playwright/test';
export {button,date,main,row,response,evidence} from '../../uat/helpers/ui';
export {ready} from '../../uat/helpers/auth';
export async function login(page:Page,login='admin',password='admin123'){
 await page.goto('/login');await page.evaluate(()=>localStorage.clear());await page.reload();
 await page.getByLabel('租户代码').fill('cd-water');await page.getByLabel('账号',{exact:true}).fill(login);await page.getByLabel('密码',{exact:true}).fill(password);
 await page.getByRole('button',{name:/登\s*录/}).click();await expect(page.getByRole('heading',{name:'工作台'})).toBeVisible();
}
export async function choose(page:Page,control:Locator,label:string,search?:string){
 const container=control.locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]');
 await container.click();
 if(search)await container.getByRole('combobox').fill(search);
 await page.locator('.ant-select-dropdown:visible').getByText(label,{exact:true}).click();
}
export function personLabel(p:any){return `${p.customer.name}（${p.customer.customerNo}）`;}
export function accountLabel(p:any){return `${p.waterAccount.accountNo} · ${p.category} · ${p.addr}`;}
export async function selectPerson(page:Page,scope:Locator,p:any,customerPlaceholder='搜索客户名称',accountPlaceholder='选择水表户'){
 await choose(page,scope.getByText(customerPlaceholder,{exact:true}),personLabel(p),p.customer.name);
 await choose(page,scope.getByText(accountPlaceholder,{exact:true}),accountLabel(p));
}
export const month=(p:string)=>p.slice(0,4)+'-'+p.slice(4);

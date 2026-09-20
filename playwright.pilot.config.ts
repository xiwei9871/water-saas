import { defineConfig } from '@playwright/test';
import { runId, runDir } from './tests/pilot/helpers/state';
export default defineConfig({
 testDir:'./tests/pilot', workers:1, fullyParallel:false, retries:0, timeout:1_200_000,
 expect:{timeout:10_000}, outputDir:`${runDir}/test-results`,
 reporter:[['list'],['html',{outputFolder:`${runDir}/html-report`,open:'never'}],['json',{outputFile:`${runDir}/results.json`}]],
 use:{baseURL:'http://127.0.0.1:4173',channel:'chrome',viewport:{width:1440,height:900},locale:'zh-CN',timezoneId:'Asia/Shanghai',
 actionTimeout:15_000,navigationTimeout:25_000,screenshot:'only-on-failure',trace:'retain-on-failure',video:'retain-on-failure'},
 metadata:{runId,baseline:'v0.1.2-mvp',database:process.env.PILOT_DATABASE_NAME || 'water_pilot_v012'},
});

import { readFileSync } from 'node:fs';
const secrets = JSON.parse(readFileSync('/Users/xiwei/.openclaw/secrets/local-secrets.json', 'utf8'));
const cfg = JSON.parse(readFileSync('/Users/xiwei/.openclaw/openclaw.json', 'utf8'));
const prov = cfg.models.providers.openai;
const key = secrets.models.providers.openai.apiKey;
const imgPath = process.argv[2] || '/tmp/meter-bad.png';
const b64 = readFileSync(imgPath).toString('base64');
const mime = imgPath.endsWith('.png') ? 'image/png' : 'image/jpeg';

const prompt = `这是一张指针式水表照片。表盘上有多个小表盘，每个小表盘下方标有倍率（×1000、×100、×10、×1、×0.1、×0.01、×0.001、×0.0001）。
每个小表盘印有0-9十个数字，指针落在某两个数字之间。请：
1. 对每个整数位盘（×1000、×100、×10、×1）和×0.1盘，判断指针落在哪两个数字之间，报"下限数字.位置"（如指针在2和3之间偏下报2.4）。
2. 用机械联动规则交叉验证：×1盘的读数小数部分就是水表读数的小数部分；各高位盘的相对位置必须自洽。
3. 输出JSON: {"x1000":n.n,"x100":n.n,"x10":n.n,"x1":n.n,"x01":n.n,"total":"XXXX.X"}，total为最终读数。`;

const r = await fetch(prov.baseUrl + '/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
  body: JSON.stringify({
    model: 'gpt-6.1-sol',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    }],
    temperature: 0,
  }),
});
const j = await r.json();
console.log('STATUS', r.status);
console.log(JSON.stringify(j.choices?.[0]?.message?.content ?? j, null, 1).slice(0, 3000));

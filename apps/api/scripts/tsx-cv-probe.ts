const main = async () => {
  console.error('step1 import node:module');
  const { createRequire } = await import('node:module');
  console.error('step2 createRequire, import.meta.url=', import.meta.url);
  const req = createRequire(import.meta.url);
  console.error('step3 require opencv');
  const mod = req('@techstark/opencv-js') as any;
  console.error('step4 Mat?', typeof mod.Mat);
  if (!mod.Mat) await new Promise((res) => { mod.onRuntimeInitialized = () => res(0); });
  console.error('step5 READY', typeof mod.fitEllipse);
};
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });

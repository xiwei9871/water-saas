import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Remote file imports carry whole CSV/XLSX payloads inside the JSON body
  // (xlsx is base64 → ~4/3 inflation); the default ~100KB limit rejects real
  // vendor exports. UI additionally guards at 5MB.
  app.useBodyParser('json', { limit: '10mb' });
  app.useBodyParser('urlencoded', { limit: '10mb', extended: true });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();

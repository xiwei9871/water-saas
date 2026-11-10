import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { TenantPrismaService } from './tenant-prisma.js';

/**
 * X1-A 主推送：报装状态变更时向租户配置的工程系统回调地址 POST
 * 报装数据（HMAC-SHA256 签名，3 次重试，最终失败仅记日志——
 * 外部系统可用 /install/applications?updatedSince= 兜底补数）。
 */
@Injectable()
export class WebhookService {
  private readonly log = new Logger('Webhook');

  constructor(private readonly prisma: TenantPrismaService) {}

  pushInstall(tenantId: string, payload: Record<string, unknown>) {
    // 即发+重试（不阻塞业务线程）
    void this.trySend(tenantId, payload, 0);
  }

  private async trySend(tenantId: string, payload: Record<string, unknown>, attempt: number) {
    try {
      const params = await this.prisma.tenantParam.findMany({
        where: { tenantId, key: { in: ['webhook.install.url', 'webhook.install.secret'] } },
        select: { key: true, value: true },
      });
      const url = params.find((p) => p.key === 'webhook.install.url')?.value;
      const secret = (params.find((p) => p.key === 'webhook.install.secret')?.value as string) ?? '';
      if (typeof url !== 'string' || !url) return;
      const body = JSON.stringify(payload);
      const sig = createHmac('sha256', secret || 'water-saas').update(body).digest('hex');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-water-signature': sig },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (attempt < 3) {
        setTimeout(() => void this.trySend(tenantId, payload, attempt + 1), (attempt + 1) * 2000);
      } else {
        this.log.warn(`install webhook push failed after retries: ${String(e)}`);
      }
    }
  }
}

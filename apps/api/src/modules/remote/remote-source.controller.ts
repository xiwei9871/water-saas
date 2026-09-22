import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request } from 'express';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import {
  canonicalDecimal,
  fingerprintEventKey,
  buildCanonicalPayload,
  isBusinessPeriod,
  type CanonicalRemoteEvent,
} from './canonical.js';
import { RemoteEventService } from './remote-event.service.js';
import {
  columnConfigOf,
  parseVendorFile,
} from './file-import-adapter.js';
import { sha256Hex } from './canonical.js';
import { naiveLocalToUtc } from './timezone.js';
import {
  RemoteSourceService,
  type RemoteSourceBody,
  type RemoteSourcePatchBody,
} from './remote-source.service.js';

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/** Full remote detail (credentialRef, raw payloads) requires remote:manage. */
export const canRemoteManage = (req: Request): boolean => {
  const perms = req.user?.perms ?? [];
  return perms.includes('*') || perms.includes('metering:remote:manage');
};

/**
 * /remote-sources — vendor platform configuration (E5 T2). Reads need
 * metering:read (config objects, not meter data); writes need
 * metering:remote:manage + org scope on org_unit_id.
 */
@Controller('remote-sources')
export class RemoteSourceController {
  constructor(
    private readonly svc: RemoteSourceService,
    private readonly events: RemoteEventService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /remote-sources — ?q= (code/name substring) / ?type= / ?status= / paging. */
  @Get()
  @Permissions('metering:read')
  list(
    @Req() req: Request,
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.svc.list(
      currentTenant(),
      {
        ...pageArgs(take, skip),
        q,
        type,
        status,
      },
      canRemoteManage(req),
    );
  }

  /** GET /remote-sources/:id */
  @Get(':id')
  @Permissions('metering:read')
  get(@Param('id') id: string, @Req() req: Request) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'), canRemoteManage(req));
  }

  /**
   * POST /remote-sources — code/name/sourceType/adapterKey/timezone
   * required; orgUnitId nullable (tenant-wide → ALL scope only);
   * credentialRef is a vault/env REFERENCE, never a plaintext secret.
   */
  @Post()
  @Permissions('metering:remote:manage')
  create(
    @Body() body: RemoteSourceBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const parsed: RemoteSourceBody = {
      code: body?.code,
      name: body?.name,
      type: body?.type,
      adapterKey: body?.adapterKey,
      timezone: body?.timezone,
      orgUnitId:
        body?.orgUnitId === undefined || body?.orgUnitId === null
          ? null
          : assertUuid(body.orgUnitId, 'orgUnitId'),
      credentialRef: body?.credentialRef,
      config: body?.config,
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createTx(tx, ctx, parsed),
    );
  }

  /** PATCH /remote-sources/:id — mutable profile only; code/type/adapterKey immutable. */
  @Patch(':id')
  @Permissions('metering:remote:manage')
  update(@Param('id') id: string, @Body() body: RemoteSourcePatchBody, @Req() req: Request) {
    assertUuid(id, 'id');
    if (body.orgUnitId !== undefined && body.orgUnitId !== null) {
      assertUuid(body.orgUnitId, 'orgUnitId');
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateTx(tx, ctx, id, body, req),
    );
  }

  /**
   * POST /remote-sources/:id/events — canonical ingest entry point. Body:
   *   { vendorDeviceKey, businessPeriod, collectedAt, readingValue,
   *     externalEventKey?, vendorQuality?, rawPayload? } | {events: [...]}
   * Server normalizes + fingerprints; each event lands its own
   * RawRemoteEvent and immediately runs the resolution pipeline.
   * Adapters (file import in T8) call the service directly — this endpoint
   * exists for canonical JSON ingest + tests.
   */
  @Post(':id/events')
  @Permissions('metering:remote:manage')
  async ingest(@Param('id') id: string, @Body() body: { events?: IngestEventBody[] } & IngestEventBody) {
    const sourceId = assertUuid(id, 'id');
    const rows = Array.isArray(body?.events) ? body.events : [body];
    if (rows.length === 0) {
      throw new BadRequestException({ code: 'EVENTS_REQUIRED' });
    }
    const ctx = currentTenant();
    const source = await this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const s = await tx.remoteSource.findFirst({
        where: { tenantId: ctx.tenantId, id: sourceId },
        select: { timezone: true },
      });
      if (!s) throw new BadRequestException({ code: 'REMOTE_SOURCE_NOT_FOUND' });
      return s;
    });
    const canonical = rows.map((row) => toCanonical(row, source.timezone));
    return this.events.ingestBatch(ctx, sourceId, canonical);
  }

  /**
   * POST /remote-sources/:id/import — FileImportAdapter (E5 T8).
   * Body: { targetPeriod:'YYYYMM', format:'csv'|'xlsx', content, fileName? }
   *   - CSV: content is utf-8 text; XLSX: base64 of the workbook
   *   - vendor column mapping lives in source.config (design §23)
   *   - naive timestamps resolve through source.timezone
   *   - PARTIAL SUCCESS: per-row outcomes + invalid rows in the report;
   *     re-importing the same file yields IDEMPOTENT_REPLAY per row.
   */
  @Post(':id/import')
  @Permissions('metering:remote:manage')
  async import(@Param('id') id: string, @Body() body: ImportBody) {
    const sourceId = assertUuid(id, 'id');
    if (!isBusinessPeriod(body?.targetPeriod)) {
      throw new BadRequestException({ code: 'INVALID_TARGET_PERIOD' });
    }
    const format =
      body.format ??
      (body.fileName?.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv');
    if (format !== 'csv' && format !== 'xlsx') {
      throw new BadRequestException({ code: 'INVALID_FILE_FORMAT' });
    }
    if (!body.content) {
      throw new BadRequestException({ code: 'FILE_CONTENT_REQUIRED' });
    }
    const ctx = currentTenant();
    const source = await this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const s = await tx.remoteSource.findFirst({
        where: { tenantId: ctx.tenantId, id: sourceId },
      });
      if (!s) throw new BadRequestException({ code: 'REMOTE_SOURCE_NOT_FOUND' });
      return s;
    });
    const columns = columnConfigOf(source.config);
    if (!columns) {
      throw new BadRequestException({ code: 'FILE_COLUMNS_NOT_CONFIGURED' });
    }
    const parsed = parseVendorFile({
      format,
      content: body.content,
      targetPeriod: body.targetPeriod,
      timezone: source.timezone,
      columns,
      fileSha256: sha256Hex(body.content),
    });
    const outcomes = await this.events.ingestBatch(ctx, sourceId, parsed.events);
    const counts: Record<string, number> = {};
    for (const o of outcomes) counts[o.outcome] = (counts[o.outcome] ?? 0) + 1;
    return {
      fileSha256: parsed.fileSha256,
      fileName: body.fileName ?? null,
      targetPeriod: body.targetPeriod,
      totalRows: parsed.events.length + parsed.invalid.length,
      parsed: parsed.events.length,
      invalid: parsed.invalid,
      outcomes,
      counts,
    };
  }
}

interface ImportBody {
  targetPeriod?: string;
  format?: 'csv' | 'xlsx';
  fileName?: string;
  content?: string;
}

interface IngestEventBody {
  externalEventKey?: string;
  vendorDeviceKey?: string;
  businessPeriod?: string;
  collectedAt?: string;
  readingValue?: string | number;
  vendorQuality?: string;
  rawPayload?: Record<string, unknown>;
}

const toCanonical = (row: IngestEventBody, sourceTimezone: string): CanonicalRemoteEvent => {
  if (!row?.vendorDeviceKey?.trim()) {
    throw new BadRequestException({ code: 'EVENT_FIELDS_REQUIRED', field: 'vendorDeviceKey' });
  }
  if (!isBusinessPeriod(row.businessPeriod)) {
    throw new BadRequestException({ code: 'EVENT_FIELDS_REQUIRED', field: 'businessPeriod' });
  }
  // Absolute instants (offset or Z) parse directly; naive vendor timestamps
  // resolve through the SOURCE timezone — never the server's local zone.
  const rawTs = row.collectedAt?.trim();
  const collectedAt = rawTs
    ? /[zZ]|[+-]\d{2}:?\d{2}$/.test(rawTs)
      ? new Date(rawTs)
      : naiveLocalToUtc(rawTs, sourceTimezone)
    : null;
  if (!collectedAt || Number.isNaN(collectedAt.getTime())) {
    throw new BadRequestException({ code: 'EVENT_FIELDS_REQUIRED', field: 'collectedAt' });
  }
  const readingValue = canonicalDecimal(row.readingValue);
  if (readingValue === null) {
    throw new UnprocessableEntityException({ code: 'INVALID_READING_VALUE' });
  }
  const externalEventKey =
    row.externalEventKey?.trim() ||
    fingerprintEventKey({
      vendorDeviceKey: row.vendorDeviceKey.trim(),
      businessPeriod: row.businessPeriod!,
      collectedAt,
      readingValue,
    });
  const { canonicalPayload, payloadHash } = buildCanonicalPayload({
    vendorDeviceKey: row.vendorDeviceKey.trim(),
    businessPeriod: row.businessPeriod!,
    collectedAt,
    readingValue,
    vendorQuality: row.vendorQuality,
  });
  return {
    externalEventKey,
    vendorDeviceKey: row.vendorDeviceKey.trim(),
    businessPeriod: row.businessPeriod!,
    collectedAt,
    readingValue,
    vendorQuality: row.vendorQuality ?? null,
    rawPayload: row.rawPayload ?? (row as unknown as Record<string, unknown>),
    canonicalPayload,
    payloadHash,
  };
};

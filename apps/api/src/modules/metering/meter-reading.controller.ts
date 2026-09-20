import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { assertDecimal, assertOptionalDate } from '../../common/decimal.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { AnyPermissions, Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { parseReadingCsv } from './csv-import.js';
import {
  MeterReadingService,
  type NumberedReadingInput,
  type QcAction,
  type ReadingInput,
  type RowError,
  type SupersedeBody,
} from './meter-reading.service.js';

const RESULT_TYPES = new Set(['ACTUAL', 'REMOTE', 'NO_READ']);
const EXCEPTION_CODES = new Set([
  'LOCKED',
  'DIAL_DIRTY',
  'FLOODED',
  'OCCUPIED',
  'STOPPED',
  'BROKEN',
  'SUSPECTED_THEFT',
  'OTHER',
]);
const QC_ACTIONS = new Set(['pass', 'reject', 'review']);
const READ_SOURCES = new Set(['WEB', 'IMPORT', 'APP', 'REMOTE']);
const QC_STATUSES = new Set(['PENDING', 'PASSED', 'REJECTED', 'MANUAL_REVIEW']);

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/** period is char(6) YYYYMM — same guard as reading-plan.controller. */
const assertPeriod = (v: unknown, field = 'period'): string => {
  if (typeof v !== 'string' || !/^\d{6}$/.test(v)) {
    throw new BadRequestException({ code: 'PERIOD_INVALID', field });
  }
  const month = parseInt(v.slice(4), 10);
  if (month < 1 || month > 12) {
    throw new BadRequestException({ code: 'PERIOD_INVALID', field });
  }
  return v;
};

const optString = (v: unknown): string | null =>
  typeof v === 'string' ? v.trim() || null : null;

interface ReadingWireBody {
  planItemId?: string;
  resultType?: string;
  readingValue?: unknown;
  exceptionCode?: string;
  readDate?: unknown;
  source?: string;
  photoRef?: string;
  remark?: string;
}

/**
 * Wire → ReadingInput (spec §2.2 shape rules):
 *  - ACTUAL/REMOTE: readingValue required (decimal ≥ 0), exceptionCode banned
 *  - NO_READ:       exceptionCode required (enum), readingValue must be absent
 */
const parseReadingInput = (
  body: ReadingWireBody | undefined,
  defaultSource: ReadingInput['source'],
): ReadingInput => {
  if (!body?.planItemId) {
    throw new BadRequestException({ code: 'READING_FIELDS_REQUIRED' });
  }
  const resultType = body.resultType ?? '';
  if (!RESULT_TYPES.has(resultType)) {
    throw new BadRequestException({ code: 'RESULT_TYPE_INVALID', value: body.resultType });
  }
  let readingValue: ReadingInput['readingValue'];
  let exceptionCode: ReadingInput['exceptionCode'];
  if (resultType === 'NO_READ') {
    if (body.readingValue !== undefined && body.readingValue !== null) {
      throw new BadRequestException({ code: 'READING_VALUE_NOT_ALLOWED' });
    }
    if (!body.exceptionCode) {
      throw new BadRequestException({ code: 'EXCEPTION_CODE_REQUIRED' });
    }
    if (!EXCEPTION_CODES.has(body.exceptionCode)) {
      throw new BadRequestException({
        code: 'EXCEPTION_CODE_INVALID',
        value: body.exceptionCode,
      });
    }
    exceptionCode = body.exceptionCode as ReadingInput['exceptionCode'];
  } else {
    if (body.readingValue === undefined || body.readingValue === null) {
      throw new BadRequestException({ code: 'READING_VALUE_REQUIRED' });
    }
    readingValue = assertDecimal(body.readingValue, 'readingValue', { min: 0 });
    if (body.exceptionCode !== undefined && body.exceptionCode !== null) {
      throw new BadRequestException({ code: 'EXCEPTION_CODE_NOT_ALLOWED' });
    }
  }
  if (body.source !== undefined && !READ_SOURCES.has(body.source)) {
    throw new BadRequestException({ code: 'SOURCE_INVALID', value: body.source });
  }
  return {
    planItemId: assertUuid(body.planItemId, 'planItemId'),
    resultType: resultType as ReadingInput['resultType'],
    readingValue,
    exceptionCode,
    readDate: assertOptionalDate(body.readDate, 'readDate'),
    source: (body.source as ReadingInput['source']) ?? defaultSource,
    photoRef: optString(body.photoRef),
    remark: optString(body.remark),
  };
};

/** Turn a thrown HttpException into an import row-error entry. */
const rowErrorOf = (row: number, err: unknown): RowError => {
  if (err instanceof HttpException) {
    const resp = err.getResponse();
    const code =
      typeof resp === 'object' && resp !== null && 'code' in resp
        ? String((resp as { code: unknown }).code)
        : 'BAD_REQUEST';
    return { row, code, error: err.message };
  }
  throw err;
};

@Controller('meter-readings')
export class MeterReadingController {
  constructor(
    private readonly svc: MeterReadingService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /**
   * GET /meter-readings — ?planItemId / ?installationId / ?period /
   * ?resultType / ?qcStatus (QC review queue reads PENDING|MANUAL_REVIEW).
   */
  @Get()
  @Permissions('metering:read')
  list(
    @Query('planItemId') planItemId?: string,
    @Query('installationId') installationId?: string,
    @Query('period') period?: string,
    @Query('resultType') resultType?: string,
    @Query('qcStatus') qcStatus?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('q') q?: string,
  ) {
    if (planItemId !== undefined) assertUuid(planItemId, 'planItemId');
    if (installationId !== undefined) assertUuid(installationId, 'installationId');
    if (period !== undefined) assertPeriod(period);
    if (resultType !== undefined && !RESULT_TYPES.has(resultType)) {
      throw new BadRequestException({ code: 'RESULT_TYPE_INVALID' });
    }
    if (qcStatus !== undefined && !QC_STATUSES.has(qcStatus)) {
      throw new BadRequestException({ code: 'QC_STATUS_INVALID' });
    }
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      q: q?.trim().slice(0, 200),
      planItemId,
      installationId,
      period,
      resultType: resultType as 'ACTUAL' | 'REMOTE' | 'NO_READ' | undefined,
      qcStatus: qcStatus as 'PENDING' | 'PASSED' | 'REJECTED' | 'MANUAL_REVIEW' | undefined,
    });
  }

  /** GET /meter-readings/:id */
  @Get(':id')
  @Permissions('metering:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /meter-readings — one reading {planItemId, resultType, ...} or a
   * batch {items:[...]} committed in ONE transaction (a mid-batch failure
   * rolls the whole entry back). Result-type shape rules per spec §2.2 —
   * ACTUAL/REMOTE carry a value, NO_READ carries an exception code. Re-entry
   * on an already-done item → 409 ITEM_ALREADY_DONE (correction goes through
   * /:id/supersede, never through a second entry).
   */
  @Post()
  @Permissions('metering:write')
  create(
    @Body() body: ReadingWireBody & { items?: ReadingWireBody[] },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    if (body?.items !== undefined) {
      if (!Array.isArray(body.items) || body.items.length === 0) {
        throw new BadRequestException({ code: 'ITEMS_REQUIRED' });
      }
      const inputs = body.items.map((i) => parseReadingInput(i, 'WEB'));
      return withOptionalIdem(
        this.prisma,
        this.idem,
        ctx,
        { key, method: 'POST', route: req.path, body, responseStatus: 201 },
        async (tx) => {
          const readings = await this.svc.createBatchTx(tx, ctx, inputs);
          return { created: readings.length, readings };
        },
      );
    }
    const input = parseReadingInput(body, 'WEB');
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      async (tx) => (await this.svc.createBatchTx(tx, ctx, [input]))[0],
    );
  }

  /**
   * POST /meter-readings/import — bulk CSV entry. Body: {csv: string} with
   * lines `plan_item_id,result_type,reading_value,exception_code[,read_date]`
   * (see csv-import.ts), or {rows:[...]} of the same objects POST accepts.
   * ALL-OR-NOTHING: any row failure → 400 {code:IMPORT_VALIDATION_FAILED,
   * created:0, failed:[{row,code,error}]} and nothing is written; clean file
   * → 201 {created, readings}. Source is forced IMPORT per row.
   */
  @Post('import')
  @Permissions('metering:write')
  importCsv(
    @Body() body: { csv?: string; rows?: ReadingWireBody[] },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    const inputs: NumberedReadingInput[] = [];
    const preFailed: RowError[] = [];

    if (typeof body?.csv === 'string' && body.csv.trim()) {
      for (const { row, cells } of parseReadingCsv(body.csv)) {
        if (cells.length < 4 || cells.length > 5) {
          preFailed.push({
            row,
            code: 'ROW_MALFORMED',
            error: `expected 4-5 columns, got ${cells.length}`,
          });
          continue;
        }
        try {
          // '' cells → undefined: an empty value cell is "absent", which the
          // NO_READ/ACTUAL shape rules then judge normally.
          inputs.push({
            row,
            input: parseReadingInput(
              {
                planItemId: cells[0],
                resultType: cells[1],
                readingValue: cells[2] || undefined,
                exceptionCode: cells[3] || undefined,
                readDate: cells[4] || undefined,
              },
              'IMPORT',
            ),
          });
        } catch (err) {
          preFailed.push(rowErrorOf(row, err));
        }
      }
    } else if (Array.isArray(body?.rows) && body.rows.length > 0) {
      body.rows.forEach((raw, i) => {
        try {
          // Strip per-row source: import provenance is forced IMPORT —
          // a row claiming WEB provenance would pollute the audit channel.
          inputs.push({
            row: i + 1,
            input: parseReadingInput({ ...raw, source: undefined }, 'IMPORT'),
          });
        } catch (err) {
          preFailed.push(rowErrorOf(i + 1, err));
        }
      });
    } else {
      throw new BadRequestException({ code: 'IMPORT_BODY_REQUIRED' });
    }

    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      async (tx) => {
        const readings = await this.svc.importTx(tx, ctx, inputs, preFailed);
        return { created: readings.length, readings };
      },
    );
  }

  /**
   * POST /meter-readings/:id/qc — {action: pass|reject|review}. State machine
   * per spec §2.7: PENDING → PASSED|REJECTED|MANUAL_REVIEW → PASSED|REJECTED;
   * terminal states re-QC → 409. QC never touches plan_item — the item
   * records that the read happened, not that it was good.
   */
  @Post(':id/qc')
  @AnyPermissions('metering:qc', 'metering:write')
  qc(
    @Param('id') id: string,
    @Body() body: { action?: string },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    if (!body?.action || !QC_ACTIONS.has(body.action)) {
      throw new BadRequestException({ code: 'QC_ACTION_INVALID', value: body?.action });
    }
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.qcTx(tx, ctx, id, body.action as QcAction, req),
    );
  }

  /**
   * POST /meter-readings/:id/supersede — {readingValue, readDate?}: append a
   * correcting fact row pointing at this one. Original must be ACTUAL/REMOTE
   * and not already superseded (→ 409 ALREADY_SUPERSEDED).
   */
  @Post(':id/supersede')
  @Permissions('metering:write')
  supersede(
    @Param('id') id: string,
    @Body() body: { readingValue?: unknown; readDate?: unknown },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    if (body?.readingValue === undefined || body?.readingValue === null) {
      throw new BadRequestException({ code: 'READING_VALUE_REQUIRED' });
    }
    const parsed: SupersedeBody = {
      readingValue: assertDecimal(body.readingValue, 'readingValue', { min: 0 }),
      readDate: assertOptionalDate(body.readDate, 'readDate'),
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.supersedeTx(tx, ctx, id, parsed, req),
    );
  }
}

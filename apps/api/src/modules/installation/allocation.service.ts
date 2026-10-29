import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantCtx, orgInScope } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { SequenceService } from '../../common/sequence.service.js';
import { TaskService } from '../task/task.service.js';

/**
 * 1028v2 报装「放号 → 现场上号 → 信息补录」三段流（B1~B4 / C1~C4）。
 *
 *  - 放号：工程验收完成（INSTALLING）的申请批量生成「档案号 +
 *    待上号用水户（预占，PENDING_ASSIGN 不计在册）+ 立户上号任务」，
 *    任务直接指派给指定抄表员。
 *  - 上号：抄表员现场复核四项一致 + 录入表号 → 激活为
 *    PENDING_COMPLETE（已上号待补全），同时把报装申请办结归档
 *    （反写时机由原「立户向导提交」改为「上号成功」）。
 *  - 待上号/待补全户的 customer/settle 挂系统预占主体
 *    （PENDING_ONBOARD / SYS-PENDING），补录时换绑真实主体。
 */

type Tx = Prisma.TransactionClient;

const PENDING_SYSTEM_KEY = 'PENDING_ONBOARD';
const PENDING_SETTLE_NO = 'SYS-PENDING';

export interface AllocateInput {
  meterQty: number;
  caliber?: string;
  readerId: string;
  /** 人工修订起始档案号（缺省按 区域码+段号+流水 自动续号）。 */
  archiveStart?: string;
  /** 抄表日段号 01..31（缺省 01）。 */
  segNo?: string;
}

export interface ActivateInput {
  meterNo: string;
  /** 四项一致复核：水表号/档案号/地址/用户名。 */
  review: { meterNoOk: boolean; archiveNoOk: boolean; addrOk: boolean; nameOk: boolean };
  /** 上号时表计未建档的补建要素（采购入库已录信息带入）。 */
  meterInfo?: {
    serialNo?: string; brand?: string; model?: string;
    caliber?: string; maxDial?: number;
  };
  /** 表底初始读数（默认 0）。 */
  initialReading?: number;
}

@Injectable()
export class AllocationService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly seq: SequenceService,
    private readonly tasks: TaskService,
  ) {}

  /** 预占主体（find-or-create）：customer.systemKey=PENDING_ONBOARD +
      settle.settleNo=SYS-PENDING，成对出现、仅可挂 PENDING_* 状态户。 */
  private async pendingPrincipal(tx: Tx, ctx: TenantCtx) {
    let customer = await tx.customer.findFirst({
      where: { tenantId: ctx.tenantId, systemKey: PENDING_SYSTEM_KEY },
    });
    if (!customer) {
      try {
        customer = await tx.customer.create({
          data: {
            tenantId: ctx.tenantId,
            customerNo: 'SYS-PENDING',
            name: '本公司·立户预占',
            custType: 'ORG',
            systemKey: PENDING_SYSTEM_KEY,
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        customer = await tx.customer.findFirstOrThrow({
          where: { tenantId: ctx.tenantId, systemKey: PENDING_SYSTEM_KEY },
        });
      }
    }
    let settle = await tx.settleAccount.findFirst({
      where: { tenantId: ctx.tenantId, settleNo: PENDING_SETTLE_NO },
    });
    if (!settle) {
      try {
        settle = await tx.settleAccount.create({
          data: {
            tenantId: ctx.tenantId,
            settleNo: PENDING_SETTLE_NO,
            name: '本公司·立户预占',
            status: 'NORMAL',
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        settle = await tx.settleAccount.findFirstOrThrow({
          where: { tenantId: ctx.tenantId, settleNo: PENDING_SETTLE_NO },
        });
      }
    }
    return { customerId: customer.id, settleAccountId: settle.id };
  }

  /** 区域码：指定抄表员所属组织在租户组织序中的两位序号（R01..）。 */
  private async areaCode(tx: Tx, ctx: TenantCtx, readerOrgId: string) {
    const orgs = await tx.orgUnit.findMany({
      where: { tenantId: ctx.tenantId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const idx = orgs.findIndex((o) => o.id === readerOrgId);
    return `R${String((idx < 0 ? orgs.length : idx) + 1).padStart(2, '0')}`;
  }

  /** 生成连续档案号：区域码-段号-流水（流水=同前缀现有最大+1）。 */
  private async nextArchiveNos(
    tx: Tx, ctx: TenantCtx, area: string, seg: string, count: number, start?: string,
  ) {
    const prefix = `${area}-${seg}-`;
    let next = 1;
    if (start) {
      const m = start.match(new RegExp(`^${area}-${seg}-(\\d+)$`));
      if (m) next = parseInt(m[1], 10);
      else if (/^\d+$/.test(start)) next = parseInt(start, 10);
      else throw new BadRequestException({ code: 'ARCHIVE_START_INVALID', start });
    } else {
      const rows = await tx.$queryRaw<{ a: string }[]>`
        SELECT archive_no AS a FROM water_account
        WHERE tenant_id = ${ctx.tenantId}::uuid AND archive_no LIKE ${prefix + '%'}
        ORDER BY archive_no DESC LIMIT 1`;
      const tail = rows[0]?.a?.slice(prefix.length);
      if (tail && /^\d+$/.test(tail)) next = parseInt(tail, 10) + 1;
    }
    return Array.from({ length: count }, (_, i) => `${prefix}${String(next + i).padStart(3, '0')}`);
  }

  // ------------------------------------------------------------------
  // B1 放号
  // ------------------------------------------------------------------
  async allocate(ctx: TenantCtx, appId: string, input: AllocateInput) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const app = await tx.installApplication.findFirst({
        where: { tenantId: ctx.tenantId, id: appId },
      });
      if (!app) throw new NotFoundException({ code: 'APPLY_NOT_FOUND' });
      if (app.status !== 'INSTALLING') {
        throw new ConflictException({
          code: 'APPLY_NOT_ACCEPTED',
          message: '仅「工程验收完成（装表已登记）」的申请可放号',
          status: app.status,
        });
      }
      const existed = await tx.waterAccount.count({
        where: {
          tenantId: ctx.tenantId,
          sourceApplyNo: app.applyNo,
          status: { in: ['PENDING_ASSIGN', 'PENDING_COMPLETE', 'NORMAL'] },
        },
      });
      if (existed > 0) {
        throw new ConflictException({ code: 'ALREADY_ALLOCATED', count: existed });
      }
      const qty = Math.max(1, Math.min(50, Math.floor(input.meterQty || 1)));
      const reader = await tx.staff.findFirst({
        where: { tenantId: ctx.tenantId, id: input.readerId, status: 'ACTIVE' },
        select: { id: true, name: true, orgUnitId: true },
      });
      if (!reader) throw new BadRequestException({ code: 'READER_NOT_FOUND' });
      const seg = (input.segNo ?? '01').padStart(2, '0');
      if (!/^\d{2}$/.test(seg) || +seg < 1 || +seg > 31) {
        throw new BadRequestException({ code: 'SEG_NO_INVALID', seg });
      }
      const area = await this.areaCode(tx, ctx, reader.orgUnitId);
      const archiveNos = await this.nextArchiveNos(
        tx, ctx, area, seg, qty, input.archiveStart,
      );
      const principal = await this.pendingPrincipal(tx, ctx);
      const caliber = input.caliber ?? app.installCaliber ?? app.caliberReq ?? null;

      const accounts: { id: string; accountNo: string; archiveNo: string; taskId: string }[] = [];
      for (const archiveNo of archiveNos) {
        const accountNo = await this.seq.nextFormatted(
          tx, ctx.tenantId, 'account_no', 'A', ctx.staffId);
        const wa = await tx.waterAccount.create({
          data: {
            tenantId: ctx.tenantId,
            accountNo,
            customerId: principal.customerId,
            settleAccountId: principal.settleAccountId,
            usageCategory: app.usageCategory,
            addr: app.addr,
            status: 'PENDING_ASSIGN',
            billable: false,
            archiveNo,
            assignReaderId: reader.id,
            pendingCaliber: caliber,
            sourceApplyNo: app.applyNo,
            contractNo: app.contractNo ?? null,
            contractScan: app.contractScan ?? undefined,
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
          select: { id: true, accountNo: true, archiveNo: true },
        });
        // 立户上号任务：直接指派指定抄表员进其待办（无需领取，V5）。
        const task = await this.tasks.createTask(tx, ctx, {
          type: 'ACCOUNT_ACTIVATE',
          title: `立户上号 ${archiveNo} · ${app.applicantName}`,
          bizType: 'WATER_ACCOUNT',
          bizId: wa.id,
          bizLabel: `${archiveNo}（${app.applicantName} · ${app.addr}）`,
          reason: `报装申请 ${app.applyNo} 放号待现场上号`,
          context: {
            archiveNo,
            accountNo: wa.accountNo,
            addr: app.addr,
            applicantName: app.applicantName,
            caliber,
          },
          assigneeId: reader.id,
          orgUnitId: app.orgUnitId ?? undefined,
        });
        accounts.push({ id: wa.id, accountNo: wa.accountNo, archiveNo, taskId: task.id });
      }
      return {
        applyNo: app.applyNo,
        reader: { id: reader.id, name: reader.name },
        count: accounts.length,
        accounts,
      };
    });
  }

  // ------------------------------------------------------------------
  // B2 上号（抄表员：customer:read；服务内再按指派人/候选人校验）
  // ------------------------------------------------------------------
  async activate(ctx: TenantCtx, accountId: string, input: ActivateInput, perms: string[] = []) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const wa = await tx.waterAccount.findFirst({
        where: { tenantId: ctx.tenantId, id: accountId },
      });
      if (!wa) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND' });
      if (wa.status !== 'PENDING_ASSIGN') {
        throw new ConflictException({ code: 'ACCOUNT_NOT_PENDING', status: wa.status });
      }
      // 仅指派人（或管理岗 iam:write）可上号。
      const isAssignee = wa.assignReaderId === ctx.staffId;
      const isManager = perms.includes('*') || perms.includes('iam:write');
      if (!isAssignee && !isManager) {
        throw new ForbiddenException({ code: 'ACTIVATE_NOT_ASSIGNEE' });
      }
      const r = input.review;
      if (!r?.meterNoOk || !r.archiveNoOk || !r.addrOk || !r.nameOk) {
        throw new BadRequestException({
          code: 'REVIEW_INCOMPLETE',
          message: '水表号/档案号/地址/用户名四项须逐一复核一致后方可上号',
        });
      }
      const meterNo = input.meterNo?.trim();
      if (!meterNo) throw new BadRequestException({ code: 'METER_NO_REQUIRED' });

      // C4：表号须与水表档案一致；未建档允许按采购入库要素补建。
      let meter = await tx.meter.findFirst({
        where: { tenantId: ctx.tenantId, meterNo },
      });
      if (!meter) {
        const info = input.meterInfo ?? {};
        meter = await tx.meter.create({
          data: {
            tenantId: ctx.tenantId,
            meterNo,
            serialNo: info.serialNo ?? null,
            brand: info.brand ?? null,
            model: info.model ?? null,
            caliber: info.caliber ?? wa.pendingCaliber,
            maxDial: info.maxDial ?? null,
            status: 'INSTALLED',
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        });
      } else {
        // 表已装在别处有效安装中 → 拒。
        const live = await tx.meterInstallation.findFirst({
          where: {
            tenantId: ctx.tenantId, meterId: meter.id, status: 'ACTIVE',
            waterAccountId: { not: wa.id },
          },
          select: { waterAccountId: true },
        });
        if (live) throw new ConflictException({ code: 'METER_ALREADY_INSTALLED', meterNo });
        await tx.meter.update({
          where: { id: meter.id },
          data: { status: 'INSTALLED', updatedBy: ctx.staffId },
        });
      }
      const existing = await tx.meterInstallation.findFirst({
        where: { tenantId: ctx.tenantId, waterAccountId: wa.id, status: 'ACTIVE' },
      });
      if (!existing) {
        await tx.meterInstallation.create({
          data: {
            tenantId: ctx.tenantId,
            waterAccountId: wa.id,
            meterId: meter.id,
            installedAt: new Date(),
            initialReading: input.initialReading ?? 0,
            reason: 'NEW',
            status: 'ACTIVE',
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        });
      }

      const updated = await tx.waterAccount.update({
        where: { id: wa.id },
        data: {
          status: 'PENDING_COMPLETE',
          activateReview: { ...r, meterNo },
          activatedAt: new Date(),
          updatedBy: ctx.staffId,
        },
      });

      // R2 反写时机改「上号成功」：报装申请办结归档 + INSTALL_REVIEW 完结。
      if (wa.sourceApplyNo) {
        const app = await tx.installApplication.findFirst({
          where: { tenantId: ctx.tenantId, applyNo: wa.sourceApplyNo },
        });
        if (app && app.status !== 'COMPLETED') {
          await tx.installApplication.update({
            where: { id: app.id },
            data: {
              status: 'COMPLETED',
              waterAccountId: wa.id,
              meterNo,
              updatedBy: ctx.staffId,
            },
          });
          await this.tasks.autoCompleteByBiz(
            tx, ctx, 'INSTALL_REVIEW', 'INSTALL_APPLICATION', app.id, '上号完成归档');
        }
      }
      // 上号任务按完成标准自动办结（回填复核结果）。
      await this.tasks.autoCompleteByBiz(
        tx, ctx, 'ACCOUNT_ACTIVATE', 'WATER_ACCOUNT', wa.id, `上号完成：表号 ${meterNo}`);
      return updated;
    });
  }

  // ------------------------------------------------------------------
  // C1/B4 信息补录：已上号（待补全）→ 补齐客户/结算户/合同等 → 正常
  // ------------------------------------------------------------------
  async completeInfo(
    ctx: TenantCtx,
    accountId: string,
    input: {
      customerId: string;
      settleAccountId: string;
      contractNo?: string;
      contractScan?: unknown;
      readingBookId?: string;
      householdSize?: number;
      addr?: string;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const wa = await tx.waterAccount.findFirst({
        where: { tenantId: ctx.tenantId, id: accountId },
      });
      if (!wa) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND' });
      if (wa.status !== 'PENDING_COMPLETE') {
        throw new ConflictException({ code: 'ACCOUNT_NOT_PENDING_COMPLETE', status: wa.status });
      }
      const [cust, settle] = await Promise.all([
        tx.customer.findFirst({ where: { tenantId: ctx.tenantId, id: input.customerId } }),
        tx.settleAccount.findFirst({ where: { tenantId: ctx.tenantId, id: input.settleAccountId } }),
      ]);
      if (!cust) throw new BadRequestException({ code: 'CUSTOMER_NOT_FOUND' });
      if (!settle) throw new BadRequestException({ code: 'SETTLE_NOT_FOUND' });
      const updated = await tx.waterAccount.update({
        where: { id: wa.id },
        data: {
          customerId: cust.id,
          settleAccountId: settle.id,
          contractNo: input.contractNo ?? wa.contractNo,
          contractScan: (input.contractScan as Prisma.InputJsonValue) ?? wa.contractScan ?? undefined,
          addr: input.addr ?? wa.addr,
          billable: true,
          status: 'NORMAL',
          openedAt: wa.openedAt ?? new Date(),
          updatedBy: ctx.staffId,
        },
      });
      // 补录即入册（可选）——与立户向导同一不变式：册内序号 max+1，
      // 本期在途计划同步补录计划项。若已在册（如后续补办入册）则跳过。
      if (input.readingBookId) {
        const book = await tx.readingBook.findFirst({
          where: { tenantId: ctx.tenantId, id: input.readingBookId },
          select: { id: true, orgUnitId: true },
        });
        if (!book) throw new BadRequestException({ code: 'READING_BOOK_NOT_FOUND' });
        if (!orgInScope(ctx, book.orgUnitId)) {
          throw new ForbiddenException({ code: 'OUT_OF_SCOPE' });
        }
        const already = await tx.bookMeter.findFirst({
          where: { tenantId: ctx.tenantId, bookId: book.id, waterAccountId: wa.id },
          select: { bookId: true },
        });
        if (!already) {
          await tx.$queryRaw`
            SELECT id FROM reading_book
            WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${book.id}::uuid
            FOR UPDATE`;
          const seqNo =
            ((await tx.bookMeter.aggregate({
              where: { tenantId: ctx.tenantId, bookId: book.id },
              _max: { seqNo: true },
            }))._max.seqNo ?? 0) + 1;
          await tx.bookMeter.create({
            data: {
              tenantId: ctx.tenantId,
              bookId: book.id,
              waterAccountId: wa.id,
              seqNo,
              createdBy: ctx.staffId,
              updatedBy: ctx.staffId,
            },
          });
          const curPeriod = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
          const activeInst = await tx.meterInstallation.findFirst({
            where: { tenantId: ctx.tenantId, waterAccountId: wa.id, status: 'ACTIVE' },
            select: { id: true },
          });
          const plan = await tx.readingPlan.findFirst({
            where: {
              tenantId: ctx.tenantId,
              bookId: book.id,
              period: curPeriod,
              status: { in: ['OPEN', 'IN_PROGRESS'] },
            },
            select: { id: true },
          });
          if (plan && activeInst) {
            const itemSeq =
              ((await tx.readingPlanItem.aggregate({
                where: { tenantId: ctx.tenantId, planId: plan.id },
                _max: { seqNo: true },
              }))._max.seqNo ?? 0) + 1;
            await tx.readingPlanItem.create({
              data: {
                tenantId: ctx.tenantId,
                planId: plan.id,
                waterAccountId: wa.id,
                seqNo: itemSeq,
                plannedInstallationId: activeInst.id,
                status: 'PENDING',
                createdBy: ctx.staffId,
                updatedBy: ctx.staffId,
              },
            });
          }
        }
      }
      // 补录人数（可选）→ household_profile 当期生效档案。
      if (input.householdSize !== undefined && input.householdSize !== null) {
        if (!Number.isInteger(input.householdSize) || input.householdSize < 0) {
          throw new BadRequestException({ code: 'INVALID_HOUSEHOLD_SIZE' });
        }
        const curPeriod = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        await tx.waterAccountHouseholdProfile.upsert({
          where: {
            tenantId_waterAccountId_effectiveFromPeriod: {
              tenantId: ctx.tenantId,
              waterAccountId: wa.id,
              effectiveFromPeriod: curPeriod,
            },
          },
          create: {
            tenantId: ctx.tenantId,
            waterAccountId: wa.id,
            householdSize: input.householdSize,
            effectiveFromPeriod: curPeriod,
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
          update: {
            householdSize: input.householdSize,
            updatedBy: ctx.staffId,
          },
        });
      }
      // 待补全提醒任务（若有）完结。
      await this.tasks.autoCompleteByBiz(
        tx, ctx, 'ACCOUNT_COMPLETE_INFO', 'WATER_ACCOUNT', wa.id, '信息补录完成');
      return updated;
    });
  }
}

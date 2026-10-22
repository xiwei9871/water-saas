import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaskPriority, TaskStatus } from '@prisma/client';
import { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { TASK_TYPES, type TaskDictRule } from './task.types.js';

export interface CreateTaskInput {
  type: string;
  title: string;
  bizType: string;
  bizId: string;
  bizLabel?: string | null;
  reason: string;
  context?: Prisma.InputJsonValue;
  /** 数据范围锚点（册/收费柜台所属组织）；null = 不限组织。 */
  orgUnitId?: string | null;
  sourceTaskId?: string | null;
  /** 覆盖字典默认 dueDays（小时数不允许负数）。 */
  dueDays?: number;
  priority?: TaskPriority;
}

export interface CreatedTask {
  id: string;
  type: string;
  /** true = 同业务对象已有未完成任务，本次去重未新建。 */
  deduped: boolean;
  /** 候选责任人（权限反查+数据范围过滤）。 */
  candidates: { id: string; name: string }[];
  /** 无任何候选 → 需要管理员介入。 */
  noCandidate: boolean;
}

type Tx = Prisma.TransactionClient;

const TASK_SELECT = {
  id: true,
  type: true,
  title: true,
  bizType: true,
  bizId: true,
  bizLabel: true,
  reason: true,
  context: true,
  requiredPerm: true,
  orgUnitId: true,
  assigneeId: true,
  status: true,
  priority: true,
  dueAt: true,
  sourceTaskId: true,
  candidateCount: true,
  escalatedAt: true,
  completedAt: true,
  completedBy: true,
  createdAt: true,
} satisfies Prisma.TaskSelect;

const FALLBACK = new Map(TASK_TYPES.map((t) => [t.code, t]));

@Injectable()
export class TaskService {
  constructor(private readonly prisma: TenantPrismaService) {}

  // ------------------------------------------------------------------
  // T3 字典：type → {perm, dueDays, priority}，TASK_TYPE_PERM 即时生效
  // ------------------------------------------------------------------
  async resolveRule(tx: Tx, ctx: TenantCtx, type: string): Promise<TaskDictRule & { name: string }> {
    const row = await tx.sysDict.findFirst({
      where: { tenantId: ctx.tenantId, category: 'TASK_TYPE_PERM', code: type, status: 'ACTIVE' },
      select: { name: true, value: true },
    });
    const fb = FALLBACK.get(type);
    const v = (row?.value ?? {}) as Partial<TaskDictRule>;
    return {
      perm: v.perm ?? fb?.fallbackPerm ?? 'iam:write',
      dueDays: v.dueDays ?? 3,
      priority: v.priority ?? 'NORMAL',
      name: row?.name ?? fb?.name ?? type,
    };
  }

  // ------------------------------------------------------------------
  // T4/T18 权限反查 + 数据范围过滤
  // ------------------------------------------------------------------
  async resolveCandidates(
    tx: Tx,
    ctx: TenantCtx,
    requiredPerm: string,
    orgUnitId: string | null | undefined,
  ): Promise<{ id: string; name: string }[]> {
    // 拥有 requiredPerm（或通配 * / admin 角色）的 ACTIVE 员工：admin 角色
    // 在登录时即被授予 '*'（auth.service loadIdentity），但 role_permission
    // 无绑定行，候选人反查须按同一约定特判，否则管理员永远不会成为候选。
    // 角色 data_scope=ALL 的不受组织限制，ORG_SUBTREE 需其 org 子树覆盖任务锚点组织。
    const rows = await tx.$queryRaw<
      { id: string; name: string; has_all: boolean; org_unit_id: string }[]
    >`
      SELECT DISTINCT s.id, s.name,
             bool_or(r.data_scope = 'ALL' OR r.code = 'admin') AS has_all,
             s.org_unit_id
      FROM staff s
      JOIN staff_role sr ON sr.staff_id = s.id AND sr.tenant_id = s.tenant_id
      JOIN role r ON r.id = sr.role_id AND r.tenant_id = s.tenant_id
      LEFT JOIN role_permission rp ON rp.role_id = r.id AND rp.tenant_id = s.tenant_id
      LEFT JOIN permission p ON p.id = rp.permission_id AND p.tenant_id = s.tenant_id
      WHERE s.tenant_id = ${ctx.tenantId}::uuid
        AND s.status = 'ACTIVE'
        AND (p.code = ${requiredPerm} OR p.code = '*' OR r.code = 'admin')
      GROUP BY s.id, s.name, s.org_unit_id`;
    if (!orgUnitId) return rows;
    const out: { id: string; name: string }[] = [];
    for (const r of rows) {
      if (r.has_all) {
        out.push({ id: r.id, name: r.name });
        continue;
      }
      const inScope = await tx.$queryRaw<{ x: number }[]>`
        WITH RECURSIVE sub AS (
          SELECT id FROM org_unit WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${r.org_unit_id}::uuid
          UNION ALL
          SELECT o.id FROM org_unit o JOIN sub ON o.parent_id = sub.id WHERE o.tenant_id = ${ctx.tenantId}::uuid
        )
        SELECT 1 AS x FROM sub WHERE id = ${orgUnitId}::uuid LIMIT 1`;
      if (inScope.length) out.push({ id: r.id, name: r.name });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // T2 创建：域内触发点在自身 tx 中调用；幂等靠 task_open_dedupe 偏唯一索引
  // ------------------------------------------------------------------
  async createTask(tx: Tx, ctx: TenantCtx, input: CreateTaskInput): Promise<CreatedTask> {
    const rule = await this.resolveRule(tx, ctx, input.type);
    // 建单必要要素（3.3）：缺 context 必填键即拒——操作员没要素不知做什么。
    const required = TASK_TYPES.find((t) => t.code === input.type)?.requiredContext;
    if (required?.length) {
      const c = (input.context ?? {}) as Record<string, unknown>;
      const missing = required.filter((k) => c[k] === undefined || c[k] === null || c[k] === '');
      if (missing.length) {
        throw new BadRequestException({ code: 'TASK_CONTEXT_MISSING', type: input.type, missing });
      }
    }
    const candidates = await this.resolveCandidates(tx, ctx, rule.perm, input.orgUnitId);
    const dueAt =
      input.dueDays === 0
        ? null
        : new Date(Date.now() + (input.dueDays ?? rule.dueDays ?? 3) * 86400_000);
    // ON CONFLICT DO NOTHING（命中 task_open_dedupe 偏唯一索引）——PG 里
    // 捕获 P2002 再回查行不通：语句失败即整事务中止(25P02)。幂等冲突必须
    // 在 INSERT 内吞掉，RETURNING 为空 = 已有未完成同名任务。
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO task (
        id, tenant_id, type, title, biz_type, biz_id, biz_label, reason,
        context, required_perm, org_unit_id, status, priority, due_at,
        source_task_id, candidate_count, created_at, created_by,
        updated_at, updated_by
      ) VALUES (
        gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.type}, ${input.title},
        ${input.bizType}, ${input.bizId}::uuid, ${input.bizLabel ?? null},
        ${input.reason},
        ${input.context === undefined ? null : JSON.stringify(input.context)}::jsonb,
        ${rule.perm}, ${input.orgUnitId ?? null}::uuid,
        'PENDING'::"TaskStatus",
        ${input.priority ?? rule.priority ?? 'NORMAL'}::"TaskPriority",
        ${dueAt}, ${input.sourceTaskId ?? null}::uuid,
        ${candidates.length}, now(), ${ctx.staffId}::uuid, now(), ${ctx.staffId}::uuid
      )
      ON CONFLICT (tenant_id, type, biz_type, biz_id)
        WHERE status IN ('PENDING', 'CLAIMED')
        DO NOTHING
      RETURNING id`;
    if (inserted.length > 0) {
      return {
        id: inserted[0].id,
        type: input.type,
        deduped: false,
        candidates,
        noCandidate: candidates.length === 0,
      };
    }
    const existing = await tx.task.findFirst({
      where: {
        tenantId: ctx.tenantId,
        type: input.type,
        bizType: input.bizType,
        bizId: input.bizId,
        status: { in: ['PENDING', 'CLAIMED'] },
      },
      select: { id: true },
    });
    return {
      id: existing?.id ?? '',
      type: input.type,
      deduped: true,
      candidates,
      noCandidate: false,
    };
  }

  /** 供触发点在报错文案中列出候选责任人（三段式 §1.8）。 */
  static candidateNames(c: CreatedTask): string {
    return c.candidates.map((x) => x.name).join('、') || '（暂无具备权限的账号）';
  }

  /**
   * 独立事务建任务：用于「检测到异常后本事务注定回滚」的场景
   * （如结算在生成途中发现估水回退 → 任务必须落库、结算必须回滚）。
   * 嵌套 runAsTenant 拿独立连接，提交不受外层回滚影响。
   */
  async createTaskStandalone(ctx: TenantCtx, input: CreateTaskInput): Promise<CreatedTask> {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) => this.createTask(tx, ctx, input));
  }

  // ------------------------------------------------------------------
  // T17 懒升级：到期未完成任务 → URGENT + escalated_at（抄送上级见 todo 查询）
  // ------------------------------------------------------------------
  private async escalateOverdue(tx: Tx, ctx: TenantCtx) {
    await tx.task.updateMany({
      where: {
        tenantId: ctx.tenantId,
        status: { in: ['PENDING', 'CLAIMED'] },
        dueAt: { lt: new Date() },
        escalatedAt: null,
      },
      data: { escalatedAt: new Date(), priority: 'URGENT' },
    });
  }

  /** 调用方 perms（JWT claim）；'*' 视为全部权限。 */
  private permSet(perms: string[] | undefined) {
    const s = new Set(perms ?? []);
    return { has: (p: string) => s.has('*') || s.has(p), isAdmin: s.has('*') };
  }

  /** todo 命中条件：未领取任务且我是候选人（权限+范围），或我认领的处理中任务；超期任务对 iam:write 上级同样可见。 */
  private todoWhere(ctx: TenantCtx, perms: string[] | undefined, type?: string): Prisma.TaskWhereInput {
    const p = this.permSet(perms);
    const mine: Prisma.TaskWhereInput[] = [
      {
        status: 'PENDING',
        ...(p.isAdmin ? {} : { requiredPerm: { in: perms ?? [] } }),
        ...(ctx.scope === 'ALL'
          ? {}
          : { OR: [{ orgUnitId: null }, { orgUnitId: { in: ctx.orgScope } }] }),
      },
      { status: 'CLAIMED', assigneeId: ctx.staffId },
    ];
    if (p.has('iam:write')) {
      mine.push({ status: 'PENDING', escalatedAt: { not: null } });
    }
    return { tenantId: ctx.tenantId, OR: mine, ...(type ? { type } : {}) };
  }

  async list(
    ctx: TenantCtx,
    perms: string[] | undefined,
    q: { box: 'todo' | 'done' | 'alert'; type?: string; take: number; skip: number },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      await this.escalateOverdue(tx, ctx);
      const where: Prisma.TaskWhereInput =
        q.box === 'done'
          ? { tenantId: ctx.tenantId, status: { in: ['DONE', 'CANCELLED'] }, ...(q.type ? { type: q.type } : {}) }
          : q.box === 'alert'
            ? { tenantId: ctx.tenantId, status: 'PENDING', candidateCount: 0, ...(q.type ? { type: q.type } : {}) }
            : this.todoWhere(ctx, perms, q.type);
      const [items, total] = await Promise.all([
        tx.task.findMany({
          where,
          orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
          take: q.take,
          skip: q.skip,
          select: TASK_SELECT,
        }),
        tx.task.count({ where }),
      ]);
      return { items: this.decorate(await this.hydrateNames(tx, ctx, items)), total };
    });
  }

  async badge(ctx: TenantCtx, perms: string[] | undefined) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      await this.escalateOverdue(tx, ctx);
      const [todo, escalated, alerts] = await Promise.all([
        tx.task.count({ where: this.todoWhere(ctx, perms) }),
        tx.task.count({
          where: { tenantId: ctx.tenantId, ...this.todoWhere(ctx, perms), escalatedAt: { not: null } },
        }),
        this.permSet(perms).has('iam:write')
          ? tx.task.count({ where: { tenantId: ctx.tenantId, status: 'PENDING', candidateCount: 0 } })
          : Promise.resolve(0),
      ]);
      return { todo, escalated, alerts };
    });
  }

  async getById(ctx: TenantCtx, perms: string[] | undefined, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const row = await tx.task.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: TASK_SELECT,
      });
      if (!row) throw new NotFoundException({ code: 'TASK_NOT_FOUND' });
      const candidates = await this.resolveCandidates(tx, ctx, row.requiredPerm, row.orgUnitId);
      const p = this.permSet(perms);
      const isCandidate =
        p.has(row.requiredPerm) &&
        (ctx.scope === 'ALL' || !row.orgUnitId || ctx.orgScope.includes(row.orgUnitId));
      const typeName = (await this.resolveRule(tx, ctx, row.type)).name;
      const [hydrated] = this.decorate(await this.hydrateNames(tx, ctx, [row]));
      return { ...hydrated, typeName, candidates, canClaim: row.status === 'PENDING' && isCandidate };
    });
  }

  /** assignee/completedBy → 姓名（无 staff 关系，手动水合；缺名显 '—' 不裸 ID）。 */
  /** 3.4 操作指引：模板 {key} 从 context/bizLabel 渲染；缺 def 则 null。 */
  private renderGuide(row: { type: string; bizLabel: string | null; context: Prisma.JsonValue | null }): string | null {
    const tpl = TASK_TYPES.find((t) => t.code === row.type)?.guide;
    if (!tpl) return null;
    const c = (row.context ?? {}) as Record<string, unknown>;
    return tpl.replace(/\{(\w+)\}/g, (m, k) => {
      if (k === 'bizLabel') return row.bizLabel ?? m;
      const v = c[k];
      return v == null ? m : String(v);
    });
  }

  private decorate<T extends { type: string; bizLabel: string | null; context: Prisma.JsonValue | null }>(items: T[]) {
    return items.map((i) => ({
      ...i,
      guide: this.renderGuide(i),
      evidenceRequired: TASK_TYPES.find((t) => t.code === i.type)?.evidenceRequired === true,
    }));
  }

  private async hydrateNames<T extends { assigneeId: string | null; completedBy: string | null }>(
    tx: Tx,
    ctx: TenantCtx,
    items: T[],
  ) {
    const ids = [...new Set(items.flatMap((i) => [i.assigneeId, i.completedBy]).filter(Boolean))] as string[];
    if (!ids.length) {
      return items.map((i) => ({ ...i, assigneeName: null, completedByName: null }));
    }
    const staff = await tx.staff.findMany({
      where: { tenantId: ctx.tenantId, id: { in: ids } },
      select: { id: true, name: true },
    });
    const names = new Map(staff.map((s) => [s.id, s.name]));
    return items.map((i) => ({
      ...i,
      assigneeName: i.assigneeId ? (names.get(i.assigneeId) ?? null) : null,
      completedByName: i.completedBy ? (names.get(i.completedBy) ?? null) : null,
    }));
  }

  // ------------------------------------------------------------------
  // 领取式（先领先得）：原子翻转，抢输 → 409
  // ------------------------------------------------------------------
  async claim(ctx: TenantCtx, perms: string[] | undefined, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const row = await tx.task.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: { id: true, status: true, requiredPerm: true, orgUnitId: true, assigneeId: true },
      });
      if (!row) throw new NotFoundException({ code: 'TASK_NOT_FOUND' });
      const p = this.permSet(perms);
      const isCandidate =
        p.has(row.requiredPerm) &&
        (ctx.scope === 'ALL' || !row.orgUnitId || ctx.orgScope.includes(row.orgUnitId));
      if (!isCandidate) {
        throw new ForbiddenException({ code: 'TASK_NOT_CANDIDATE' });
      }
      const flipped = await tx.task.updateMany({
        where: { tenantId: ctx.tenantId, id, status: 'PENDING', assigneeId: null },
        data: { status: 'CLAIMED', assigneeId: ctx.staffId, updatedBy: ctx.staffId },
      });
      if (flipped.count === 0) {
        throw new ConflictException({ code: 'TASK_ALREADY_CLAIMED', assigneeId: row.assigneeId });
      }
      return tx.task.findUniqueOrThrow({ where: { id }, select: TASK_SELECT });
    });
  }

  /**
   * 完成（3.4）：三闭环最后一环——
   *  1. 处理结果必填（result_note）；
   *  2. 现场类任务必须上传佐证（result_evidence 非空）；
   *  3. 完成标准校验：业务动作未达成 → TASK_NOT_DONE 拦截。
   */
  async complete(
    ctx: TenantCtx,
    id: string,
    note?: string,
    evidenceRefs?: unknown[],
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const row = await tx.task.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: { id: true, status: true, assigneeId: true, context: true, type: true, bizType: true, bizId: true },
      });
      if (!row) throw new NotFoundException({ code: 'TASK_NOT_FOUND' });
      const def = TASK_TYPES.find((t) => t.code === row.type);
      const trimmed = note?.trim() ?? '';
      if (!trimmed) {
        throw new BadRequestException({ code: 'TASK_RESULT_REQUIRED', message: '请填写处理结果' });
      }
      const ev = Array.isArray(evidenceRefs) ? evidenceRefs.filter((x) => x != null && x !== '') : [];
      if (def?.evidenceRequired && ev.length === 0) {
        throw new BadRequestException({
          code: 'TASK_EVIDENCE_REQUIRED',
          message: '现场类任务完成须上传佐证（照片/单据）',
        });
      }
      await this.assertDoneStandard(tx, ctx, row);
      const context =
        row.context && typeof row.context === 'object' && !Array.isArray(row.context)
          ? { ...(row.context as Record<string, unknown>), completionNote: trimmed }
          : { completionNote: trimmed };
      const flipped = await tx.task.updateMany({
        where: { tenantId: ctx.tenantId, id, status: 'CLAIMED', assigneeId: ctx.staffId },
        data: {
          status: 'DONE',
          completedAt: new Date(),
          completedBy: ctx.staffId,
          resultNote: trimmed,
          ...(ev.length ? { resultEvidence: ev as Prisma.InputJsonValue } : {}),
          context,
          updatedBy: ctx.staffId,
        },
      });
      if (flipped.count === 0) {
        throw new ConflictException({ code: 'TASK_NOT_CLAIMED_BY_ME', status: row.status });
      }
      return tx.task.findUniqueOrThrow({ where: { id }, select: TASK_SELECT });
    });
  }

  /**
   * 完成标准（3.4）：空点「完成」不允许——业务侧必须已有对应终态。
   * 自动完结路径（业务动作本身触发 autoCompleteByBiz）不受此校验。
   */
  private async assertDoneStandard(
    tx: Tx,
    ctx: TenantCtx,
    row: { type: string; bizType: string; bizId: string; context: Prisma.JsonValue | null },
  ): Promise<void> {
    const fail = (code: string, message: string) => {
      throw new ConflictException({ code, message });
    };
    switch (row.type) {
      case 'METER_REVIEW': {
        const r = await tx.meterReading.findFirst({
          where: { tenantId: ctx.tenantId, id: row.bizId },
          select: { qcStatus: true },
        });
        if (r && !['PASSED', 'REJECTED'].includes(r.qcStatus)) {
          fail('TASK_NOT_DONE', '尚未对该读数提交质检结论');
        }
        break;
      }
      case 'SUPPLEMENT': {
        const c = (row.context ?? {}) as Record<string, unknown>;
        const waId = c.waterAccountId as string | undefined;
        const period = c.period as string | undefined;
        if (!waId || !period) break;
        // 补差落地形态：reconciliation 终态单（APPLIED/ABSORBED）或其产生的 ADJUSTMENT 账单。
        const [recon, adj] = await Promise.all([
          tx.reconciliation.findFirst({
            where: {
              tenantId: ctx.tenantId,
              waterAccountId: waId,
              toPeriod: period,
              status: { in: ['APPLIED', 'ABSORBED'] },
            },
            select: { id: true },
          }),
          tx.bill.findFirst({
            where: { tenantId: ctx.tenantId, waterAccountId: waId, period, billKind: 'ADJUSTMENT' },
            select: { id: true },
          }),
        ]);
        if (!recon && !adj) fail('TASK_NOT_DONE', '尚未生成该期补差单');
        break;
      }
      case 'COLLECTION': {
        const c = (row.context ?? {}) as Record<string, unknown>;
        if (c.noticeId) break; // 走通知单流程创建的任务：单据已生成
        const notice = await tx.collectionNotice.findFirst({
          where: { tenantId: ctx.tenantId, id: (c.noticeId as string) ?? row.bizId },
          select: { id: true },
        });
        if (!notice) fail('TASK_NOT_DONE', '尚未生成催缴通知单');
        break;
      }
      case 'SVC_APPROVAL': {
        const o = await tx.meterServiceOrder.findFirst({
          where: { tenantId: ctx.tenantId, id: row.bizId },
          select: { status: true },
        });
        if (o?.status === 'PENDING_APPROVAL') fail('TASK_NOT_DONE', '工单尚未审批');
        break;
      }
      case 'SVC_EXECUTE':
      case 'METER_SERVICE': {
        const o = await tx.meterServiceOrder.findFirst({
          where: { tenantId: ctx.tenantId, id: row.bizId },
          select: { status: true },
        });
        if (o && !['EXECUTED', 'ARCHIVED', 'REJECTED', 'CANCELLED'].includes(o.status)) {
          fail('TASK_NOT_DONE', '工单尚未执行归档（含佐证）');
        }
        break;
      }
      case 'VIOLATION_HANDLE': {
        const v = await tx.waterViolation.findFirst({
          where: { tenantId: ctx.tenantId, id: row.bizId },
          select: { status: true },
        });
        if (v && !['PROCESSED', 'ARCHIVED', 'DISMISSED'].includes(v.status)) {
          fail('TASK_NOT_DONE', '违章尚未核实处置并归档');
        }
        break;
      }
      case 'INSTALL_REVIEW': {
        const a = await tx.installApplication.findFirst({
          where: { tenantId: ctx.tenantId, id: row.bizId },
          select: { status: true },
        });
        if (a && !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(a.status)) {
          fail('TASK_NOT_DONE', '报装申请尚未归档或驳回');
        }
        break;
      }
      case 'RECON_HANDLE': {
        const b = await tx.channelReconBatch.findFirst({
          where: { tenantId: ctx.tenantId, id: row.bizId },
          select: { id: true, mismatched: true, missingInFile: true },
        });
        if (b) {
          const open = await tx.channelReconRow.count({
            where: { tenantId: ctx.tenantId, batchId: row.bizId, matchStatus: { not: 'MATCHED' } },
          });
          if (open > 0) fail('TASK_NOT_DONE', `对账批次尚有 ${open} 行差异未处理`);
        }
        break;
      }
      case 'WRITEOFF_APPROVAL':
      case 'REVERSAL_APPROVAL':
      default:
        break; // 复核/审批类：处理结果+佐证即完成，业务终态不反向校验
    }
  }

  async cancel(ctx: TenantCtx, perms: string[] | undefined, id: string, reason?: string) {
    // 取消是管理动作：仅 iam:write / 管理员可执行，普通候选人不能销任务。
    if (!this.permSet(perms).has('iam:write')) {
      throw new ForbiddenException({ code: 'TASK_CANCEL_DENIED' });
    }
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const flipped = await tx.task.updateMany({
        where: { tenantId: ctx.tenantId, id, status: { in: ['PENDING', 'CLAIMED'] } },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: reason ?? null,
          updatedBy: ctx.staffId,
        },
      });
      if (flipped.count === 0) {
        const row = await tx.task.findFirst({ where: { tenantId: ctx.tenantId, id }, select: { id: true } });
        if (!row) throw new NotFoundException({ code: 'TASK_NOT_FOUND' });
        throw new ConflictException({ code: 'TASK_NOT_OPEN' });
      }
      return tx.task.findUniqueOrThrow({ where: { id }, select: TASK_SELECT });
    });
  }

  // ------------------------------------------------------------------
  // T9/T16 阻断查询：结算/出账在自身 tx 中调用
  // ------------------------------------------------------------------
  async openTasksForBiz(
    tx: Tx,
    ctx: TenantCtx,
    types: readonly string[],
    bizType: string,
    bizId?: string,
  ) {
    return tx.task.findMany({
      where: {
        tenantId: ctx.tenantId,
        type: { in: [...types] },
        bizType,
        ...(bizId ? { bizId } : {}),
        status: { in: ['PENDING', 'CLAIMED'] },
      },
      select: { id: true, type: true, title: true, bizId: true, bizLabel: true, requiredPerm: true, orgUnitId: true },
    });
  }

  /**
   * 域内级联：业务动作本身完成时（如核销应用）自动关闭匹配任务。
   * 返回关闭条数；无 open 任务时静默 0。
   */
  async autoCompleteByBiz(
    tx: Tx,
    ctx: TenantCtx,
    type: string,
    bizType: string,
    bizId: string,
    note?: string,
  ) {
    const r = await tx.task.updateMany({
      where: {
        tenantId: ctx.tenantId,
        type,
        bizType,
        bizId,
        status: { in: ['PENDING', 'CLAIMED'] },
      },
      data: {
        status: 'DONE',
        completedAt: new Date(),
        completedBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });
    return r.count;
  }

  /** 指定业务对象上某类任务是否已 DONE（完成即解锁的判定依据）。 */
  async hasDoneTask(
    tx: Tx,
    ctx: TenantCtx,
    type: string,
    bizType: string,
    bizId: string,
    contextPeriod?: string,
  ) {
    const row = await tx.task.findFirst({
      where: {
        tenantId: ctx.tenantId,
        type,
        bizType,
        bizId,
        status: 'DONE',
        ...(contextPeriod ? { context: { path: ['period'], equals: contextPeriod } } : {}),
      },
      select: { id: true },
    });
    return row !== null;
  }
}

# Notifications Slice 1b — Remaining Email Events Implementation Plan

> **Workflow:** teaching-first, per-task. Claude teaches + gives full reference code; **the user writes production code**; **Claude writes + runs tests**. Auto-commit + push at green checkpoints. Verbose object literals. A human runs `npm run test:e2e`.

**Goal:** email notifications for every account-lifecycle, order/audit and stock event in the spec, with stock alerts emitted **only after the surrounding transaction commits**, plus a safety-net cron for notifications stuck in `PENDING`.

**Spec:** `docs/superpowers/specs/2026-09-23-notifications-and-account-security-design.md` · **Builds on:** Slice 1a (`docs/superpowers/plans/2026-09-23-notifications-slice-1a-foundation-email.md`).

## Decisions (from the 1b brainstorm)
- **Emit-after-commit = return & collect.** `recordWithinTransaction` never emits; it returns a `stockChange` report. Callers collect reports from their `$transaction` result and call `inventory.emitStockAlerts(changes)` after it resolves. A rollback means the emit line is never reached.
- **Crossing is judged per product, per transaction:** available at the **first** write vs at the **last** write. (Per-write checks give false alarms: `fulfill` = RELEASE +q then SALE −q.) Alert iff `target > 0 && firstBefore >= target && lastAfter < target`.
- **Who collects:** callers that can *lower* available stock: `InventoryService.record`, `AuditsService.apply`, `ReservationsService.create` (HOLD) and `fulfill` (SALE). `cancel` and the expiry sweep only RELEASE (raises available) → they can't cross; they keep ignoring the return value, with a comment.
- **Recipients:** action events exclude the actor (dedupe manager/owner). **Stock alerts do not exclude anyone** (a state warning, not an action receipt).
- **Duplicate-proof enqueue:** `jobId: notification.id` on every job; a reconciliation cron re-adds `PENDING` rows older than 10 min (BullMQ ignores an `add` whose `jobId` already exists).

## Event catalogue (1b)

| Event | Emitted by (after the write) | Payload | Recipients |
|---|---|---|---|
| `company.registered` | `AuthService.register` (after its `$transaction`) | `{ companyId }` | platform admins |
| `member.joinRequested` | `AuthService.registerMember` | `{ companyId, memberUserId }` | company owner(s) |
| `member.approved` | `UsersService.approveMember` | `{ memberUserId, approvedByUserId }` | the member (minus actor) |
| `order.created` | `OrdersService.create` | `{ orderId, cornerId, createdByUserId }` | corner manager + owner(s), minus actor |
| `audit.applied` | `AuditsService.apply` (after its `$transaction`) | `{ auditId, cornerId, appliedByUserId }` | corner manager + owner(s), minus actor |
| `stock.belowTarget` | `InventoryService.emitStockAlerts` (called by stock writers after commit) | `{ placementId, availableQuantity, targetStockQuantity }` | corner manager + owner(s) |

---

### Task 1: Events, templates, recipient helpers, `emailUsers`, `jobId`

**`notification-events.ts`**: extend the map + add payload interfaces:
```ts
export const NotificationEvent = {
  COMPANY_APPROVED: 'company.approved',
  COMPANY_REGISTERED: 'company.registered',
  MEMBER_JOIN_REQUESTED: 'member.joinRequested',
  MEMBER_APPROVED: 'member.approved',
  ORDER_CREATED: 'order.created',
  AUDIT_APPLIED: 'audit.applied',
  STOCK_BELOW_TARGET: 'stock.belowTarget',
} as const;

export interface CompanyRegisteredEvent {
  companyId: string;
}
export interface MemberJoinRequestedEvent {
  companyId: string;
  memberUserId: string;
}
export interface MemberApprovedEvent {
  memberUserId: string;
  approvedByUserId: string;
}
export interface OrderCreatedEvent {
  orderId: string;
  cornerId: string;
  createdByUserId: string;
}
export interface AuditAppliedEvent {
  auditId: string;
  cornerId: string;
  appliedByUserId: string;
}
export interface StockBelowTargetEvent {
  placementId: number;
  availableQuantity: number;
  targetStockQuantity: number;
}
```

**`notification-templates.ts`**: add (keep `companyApproved`):
```ts
  companyRegistered: (companyName: string): RenderedMessage => ({
    subject: '[Inventra] 새 회사 가입 승인 요청',
    body: `${companyName} 회사가 가입을 신청했습니다. 관리자 화면에서 승인해 주세요.`,
  }),
  memberJoinRequested: (memberName: string, companyName: string): RenderedMessage => ({
    subject: '[Inventra] 새 구성원 가입 요청',
    body: `${memberName}님이 ${companyName}에 가입을 요청했습니다. 역할을 지정해 승인해 주세요.`,
  }),
  memberApproved: (companyName: string): RenderedMessage => ({
    subject: '[Inventra] 가입이 승인되었습니다',
    body: `${companyName}의 구성원으로 승인되었습니다. 이제 Inventra에 로그인할 수 있습니다.`,
  }),
  orderCreated: (cornerName: string, orderTitle: string, itemCount: number): RenderedMessage => ({
    subject: '[Inventra] 새 발주가 등록되었습니다',
    body: `${cornerName} 코너에 발주 "${orderTitle}"(${itemCount}개 품목)가 등록되었습니다.`,
  }),
  auditApplied: (cornerName: string, auditTitle: string, itemCount: number): RenderedMessage => ({
    subject: '[Inventra] 재고 실사가 반영되었습니다',
    body: `${cornerName} 코너의 실사 "${auditTitle}"(${itemCount}개 품목)가 재고에 반영되었습니다.`,
  }),
  stockBelowTarget: (
    cornerName: string,
    productName: string,
    availableQuantity: number,
    targetStockQuantity: number,
  ): RenderedMessage => ({
    subject: '[Inventra] 재고 부족 알림',
    body: `${cornerName} 코너의 ${productName} 가용 재고가 ${availableQuantity}개로 목표 수량(${targetStockQuantity}개)보다 적습니다.`,
  }),
```

**`notifications.service.ts`**: `jobId` on enqueue + recipient helpers + `emailUsers`:
```ts
    await this.queue.add(
      SEND_NOTIFICATION_JOB,
      { notificationId: notification.id },
      { ...SEND_JOB_OPTIONS, jobId: notification.id },
    );
```
```ts
  // -- Recipients (active, not deleted) --
  async findPlatformAdminIds(): Promise<string[]> {
    const admins = await this.prisma.user.findMany({
      where: { role: { code: 'ADMIN' }, status: UserStatus.ACTIVE, deletedAt: null },
      select: { id: true },
    });
    return admins.map((admin) => admin.id);
  }

  async findCompanyOwnerIds(companyId: string): Promise<string[]> {
    const owners = await this.prisma.user.findMany({
      where: {
        companyId: companyId,
        role: { code: 'OWNER' },
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true },
    });
    return owners.map((owner) => owner.id);
  }

  /** Corner manager (if any) + the corner company's owner(s). */
  async findCornerRecipientIds(cornerId: string): Promise<string[]> {
    const corner = await this.prisma.companyStore.findUnique({
      where: { id: cornerId },
      select: { companyId: true, managerUserId: true },
    });
    if (!corner) return [];
    const ownerIds = await this.findCompanyOwnerIds(corner.companyId);
    return corner.managerUserId ? [corner.managerUserId, ...ownerIds] : ownerIds;
  }

  /** Email each user once (deduplicated), skipping the actor and users with no email. */
  async emailUsers(input: {
    userIds: string[];
    excludeUserId?: string;
    eventType: string;
    message: RenderedMessage;
  }): Promise<void> {
    const recipientIds = [...new Set(input.userIds)].filter(
      (userId) => userId !== input.excludeUserId,
    );
    for (const userId of recipientIds) {
      const email = await this.findUserEmail(userId);
      if (!email) continue;
      await this.dispatch({
        eventType: input.eventType,
        channel: NotificationChannel.EMAIL,
        recipientUserId: userId,
        recipientAddress: email,
        subject: input.message.subject,
        body: input.message.body,
      });
    }
  }
```
(imports: `UserStatus` from the generated enums, `RenderedMessage` type from `./notification-templates`.)

- [ ] User writes. Claude: extend `notifications.service.spec.ts` (jobId; each finder's query; `findCornerRecipientIds` with/without manager + missing corner; `emailUsers` dedupes, excludes the actor, skips users without email).

---

### Task 2: Stock-change reports + `emitStockAlerts` (InventoryService)

**`src/inventory/stock-change.ts`** (new, type-only + pure helper):
```ts
import type { StockBelowTargetEvent } from '../notifications/notification-events';

export interface StockChange {
  placementId: number;
  availableBefore: number;
  availableAfter: number;
  targetStockQuantity: number;
}

/** Per placement: first `availableBefore` vs last `availableAfter` across one transaction. */
export function stockAlertsFrom(changes: StockChange[]): StockBelowTargetEvent[] {
  const byPlacement = new Map<number, { first: StockChange; last: StockChange }>();
  for (const change of changes) {
    const seen = byPlacement.get(change.placementId);
    if (seen) seen.last = change;
    else byPlacement.set(change.placementId, { first: change, last: change });
  }
  const alerts: StockBelowTargetEvent[] = [];
  for (const { first, last } of byPlacement.values()) {
    const target = last.targetStockQuantity;
    if (target > 0 && first.availableBefore >= target && last.availableAfter < target) {
      alerts.push({
        placementId: last.placementId,
        availableQuantity: last.availableAfter,
        targetStockQuantity: target,
      });
    }
  }
  return alerts;
}
```

**`InventoryService`**: inject `EventEmitter2` (new last constructor arg); `recordWithinTransaction` returns `{ ledgerEntry, stockChange }`; `record` emits after its `$transaction`; new `emitStockAlerts`:
```ts
    // after computing quantityBefore/After, before creating the ledger row:
    const availableDelta =
      effect.kind === 'set'
        ? q - stock.availableQuantity
        : effect.deltas
            .filter((delta) => delta.field === 'availableQuantity')
            .reduce((sum, delta) => sum + delta.sign * q, 0);
    const stockChange: StockChange = {
      placementId: placementId,
      availableBefore: stock.availableQuantity,
      availableAfter: stock.availableQuantity + availableDelta,
      targetStockQuantity: stock.targetStockQuantity,
    };

    const ledgerEntry = await tx.inventoryTransaction.create({ ...same data... });
    return { ledgerEntry: ledgerEntry, stockChange: stockChange };
```
```ts
  async record(...) {
    ...
    const { ledgerEntry, stockChange } = await this.prisma.$transaction((tx) =>
      this.recordWithinTransaction(tx, placementId, dto, caller.id, source),
    );
    this.emitStockAlerts([stockChange]); // only reached if the transaction committed
    return ledgerEntry;                  // HTTP response unchanged
  }

  /** Call only AFTER the transaction that produced these changes has committed. */
  emitStockAlerts(changes: StockChange[]): void {
    for (const alert of stockAlertsFrom(changes)) {
      this.eventEmitter.emit(NotificationEvent.STOCK_BELOW_TARGET, alert);
    }
  }
```

- [ ] User writes. Claude: `stock-change.spec.ts` (no alert when target 0 / already below / stays above; alert on crossing; **fulfill-shaped RELEASE+SALE on the same placement = no false alarm**; multiple placements independent) + update `inventory.service.spec.ts` (new return shape, stockChange math for delta and set effects, `record` emits only after commit and returns the ledger row).

---

### Task 3: Stock writers collect + emit after commit

**`AuditsService.apply`** — collect inside, emit outside (plus `audit.applied`, Task 4):
```ts
    const { appliedAudit, stockChanges } = await this.prisma.$transaction(async (tx) => {
      const changes: StockChange[] = [];
      for (const item of audit.inventoryAuditItems) {
        const { stockChange } = await this.inventory.recordWithinTransaction(tx, …same args…);
        changes.push(stockChange);
      }
      const updated = await tx.inventoryAudit.update({ …same… });
      return { appliedAudit: updated, stockChanges: changes };
    });
    this.inventory.emitStockAlerts(stockChanges);
    return appliedAudit;
```

**`ReservationsService.create`** (HOLD lowers available) and **`fulfill`** (RELEASE + SALE): same shape: return `{ reservation, stockChanges }` from the transaction, `emitStockAlerts(stockChanges)` after it, return the reservation.

**`cancel`** and **`ReservationExpiryService`**: unchanged, add a comment: `// RELEASE only raises available stock, so it can never cross below target — no stock alert to collect.`

- [ ] User writes. Claude: update `audits.service.spec.ts`, `reservations.service.spec.ts` (mocks return `{ ledgerEntry, stockChange }`; `emitStockAlerts` called with the collected changes after the transaction; not called when the transaction throws).

---

### Task 4: Emit points + listener handlers

- **`AuthService`** gains `EventEmitter2`: after `register`'s `$transaction` → `COMPANY_REGISTERED { companyId: company.id }`; after `registerMember`'s create → `MEMBER_JOIN_REQUESTED { companyId: company.id, memberUserId: user.id }`.
- **`UsersService.approveMember`**: `const approvedMember = await …update…; emit(MEMBER_APPROVED, { memberUserId: target.id, approvedByUserId: caller.id }); return approvedMember;`
- **`OrdersService`** gains `EventEmitter2` (last arg): `create` → `const order = await …create…; emit(ORDER_CREATED, { orderId: order.id, cornerId: cornerId, createdByUserId: caller.id }); return order;`
- **`AuditsService.apply`** (from Task 3): after `emitStockAlerts`, `emit(AUDIT_APPLIED, { auditId: auditId, cornerId: cornerId, appliedByUserId: caller.id })` — `AuditsService` gains `EventEmitter2`.

**`NotificationsListener`**: one handler per event:
```ts
  @OnEvent(NotificationEvent.COMPANY_REGISTERED)
  async handleCompanyRegistered(event: CompanyRegisteredEvent): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: event.companyId }, select: { name: true },
    });
    if (!company) return;
    await this.notifications.emailUsers({
      userIds: await this.notifications.findPlatformAdminIds(),
      eventType: NotificationEvent.COMPANY_REGISTERED,
      message: notificationTemplates.companyRegistered(company.name),
    });
  }

  @OnEvent(NotificationEvent.MEMBER_JOIN_REQUESTED)
  async handleMemberJoinRequested(event: MemberJoinRequestedEvent): Promise<void> {
    const [company, member] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: event.companyId }, select: { name: true } }),
      this.prisma.user.findUnique({ where: { id: event.memberUserId }, select: { name: true } }),
    ]);
    if (!company || !member) return;
    await this.notifications.emailUsers({
      userIds: await this.notifications.findCompanyOwnerIds(event.companyId),
      excludeUserId: event.memberUserId,
      eventType: NotificationEvent.MEMBER_JOIN_REQUESTED,
      message: notificationTemplates.memberJoinRequested(member.name, company.name),
    });
  }

  @OnEvent(NotificationEvent.MEMBER_APPROVED)
  async handleMemberApproved(event: MemberApprovedEvent): Promise<void> {
    const member = await this.prisma.user.findUnique({
      where: { id: event.memberUserId },
      select: { company: { select: { name: true } } },
    });
    if (!member?.company) return;
    await this.notifications.emailUsers({
      userIds: [event.memberUserId],
      excludeUserId: event.approvedByUserId,
      eventType: NotificationEvent.MEMBER_APPROVED,
      message: notificationTemplates.memberApproved(member.company.name),
    });
  }

  @OnEvent(NotificationEvent.ORDER_CREATED)
  async handleOrderCreated(event: OrderCreatedEvent): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { id: event.orderId, companyStoreId: event.cornerId },
      select: { title: true, companyStore: { select: { name: true } }, _count: { select: { orderItems: true } } },
    });
    if (!order) return;
    await this.notifications.emailUsers({
      userIds: await this.notifications.findCornerRecipientIds(event.cornerId),
      excludeUserId: event.createdByUserId,
      eventType: NotificationEvent.ORDER_CREATED,
      message: notificationTemplates.orderCreated(order.companyStore.name, order.title, order._count.orderItems),
    });
  }

  @OnEvent(NotificationEvent.AUDIT_APPLIED)
  async handleAuditApplied(event: AuditAppliedEvent): Promise<void> {
    const audit = await this.prisma.inventoryAudit.findFirst({
      where: { id: event.auditId, companyStoreId: event.cornerId },
      select: { title: true, companyStore: { select: { name: true } }, _count: { select: { inventoryAuditItems: true } } },
    });
    if (!audit) return;
    await this.notifications.emailUsers({
      userIds: await this.notifications.findCornerRecipientIds(event.cornerId),
      excludeUserId: event.appliedByUserId,
      eventType: NotificationEvent.AUDIT_APPLIED,
      message: notificationTemplates.auditApplied(audit.companyStore.name, audit.title, audit._count.inventoryAuditItems),
    });
  }

  @OnEvent(NotificationEvent.STOCK_BELOW_TARGET)
  async handleStockBelowTarget(event: StockBelowTargetEvent): Promise<void> {
    const placement = await this.prisma.companyStoreProduct.findUnique({
      where: { id: event.placementId },
      select: { companyStoreId: true, companyStore: { select: { name: true } }, product: { select: { name: true } } },
    });
    if (!placement) return;
    await this.notifications.emailUsers({
      userIds: await this.notifications.findCornerRecipientIds(placement.companyStoreId),
      eventType: NotificationEvent.STOCK_BELOW_TARGET,
      message: notificationTemplates.stockBelowTarget(
        placement.companyStore.name, placement.product.name,
        event.availableQuantity, event.targetStockQuantity,
      ),
    });
  }
```
(All payload interfaces imported with `import type` — decorated signatures.)

- [ ] User writes. Claude: emit tests in `auth.service.spec.ts`, `users.service.spec.ts`, `orders.service.spec.ts`, `audits.service.spec.ts` (emitted after the write, right payload, not emitted on failure) + listener tests per handler (recipients, actor exclusion, template, missing-row no-ops).

---

### Task 5: Reconciliation cron

`src/notifications/notifications.reconciler.ts` (provider in `NotificationsModule`):
```ts
@Injectable()
export class NotificationsReconciler {
  private readonly logger = new Logger(NotificationsReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  /** Re-enqueue notifications stuck in PENDING (e.g. Redis was down when dispatch() ran). */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async requeueStalePending(): Promise<number> {
    const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
    const stale = await this.prisma.notification.findMany({
      where: { status: NotificationStatus.PENDING, createdAt: { lt: staleBefore } },
      select: { id: true },
      take: 100,
    });
    for (const notification of stale) {
      // Same jobId as the original: if that job still exists, BullMQ ignores this add.
      await this.queue.add(
        SEND_NOTIFICATION_JOB,
        { notificationId: notification.id },
        { ...SEND_JOB_OPTIONS, jobId: notification.id },
      );
    }
    if (stale.length > 0) this.logger.warn(`Re-enqueued ${stale.length} stale notification(s)`);
    return stale.length;
  }
}
```

- [ ] User writes. Claude: `notifications.reconciler.spec.ts` (query window + status; re-adds with `jobId`; returns the count; no-op when none).

---

### Task 6: e2e + checkpoint

Extend `test/notifications.e2e-spec.ts`:
- register company → **admin** receives `company.registered`;
- member joins → **owner** receives `member.joinRequested`; owner approves → **member** receives `member.approved`;
- manager files an order → **owner** receives `order.created`, the **manager (actor) does not**;
- placement target 10, restock to 12, sale of 5 → **stock alert** (available 7) to manager + owner; a second sale does **not** re-alert (already below).

- [ ] Human runs `npm run test:e2e`. On green: commit + push; STATUS → Slice 1b done, Slice 2 (SMS + phone verification) next.

## Self-review
- Every 1b event has an emitter, a payload type, a template, a handler, unit tests and e2e coverage. ✅
- Emit-after-commit holds for every writer that can lower available stock; the two RELEASE-only callers are documented. ✅
- `record()`'s HTTP response is unchanged (`ledgerEntry`). ✅

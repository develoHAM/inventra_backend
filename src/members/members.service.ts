import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { OwnershipService } from '../authorization/ownership.service';
import { CornersService } from '../corners/corners.service';
import { MembershipHistoryService } from '../membership-history/membership-history.service';
import { StorageService } from '../storage/storage.service';
import type { AuthUser } from '../auth/types/auth-user';
import { MembershipChangeReason, UserStatus } from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';
import type { MemberMovedEvent } from '../notifications/notification-events';
import { isMemberRole } from './member-rules';
import { MEMBER_SELECT } from './member-view';
import type { MemberRow, MemberView } from './member-view';
import { ChangeBranchDto } from './dto/change-branch.dto';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly corners: CornersService,
    private readonly history: MembershipHistoryService,
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Move a manager or staff member to another branch, or off theirs (null). */
  async changeBranch(
    caller: AuthUser,
    userId: string,
    dto: ChangeBranchDto,
  ): Promise<MemberView> {
    if (caller.roleCode !== 'ADMIN' && caller.roleCode !== 'OWNER')
      throw new ForbiddenException(
        'Only an owner can move members between branches',
      );

    const target = await this.findTarget(caller, userId);
    if (target.status !== UserStatus.ACTIVE)
      throw new BadRequestException('Only active members can be changed');
    if (target.roleCode !== 'MANAGER' && target.roleCode !== 'STAFF')
      throw new BadRequestException(
        'Only managers and staff belong to a branch',
      );
    if (target.companyStoreId === dto.cornerId) return this.toView(target);

    await this.prisma.$transaction(async (transaction) => {
      if (dto.cornerId !== null) {
        const isLive = await this.corners.lockLiveCorner(
          transaction,
          dto.cornerId,
          target.companyId,
        );
        if (!isLive) throw new NotFoundException('Branch not found');
      }

      // The where repeats what we read: if anyone changed this member in
      // between, nothing matches and count is 0.
      const moved = await transaction.user.updateMany({
        where: {
          id: target.id,
          companyId: target.companyId,
          roleId: target.roleId,
          companyStoreId: target.companyStoreId,
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
        data: { companyStoreId: dto.cornerId },
      });
      if (moved.count === 0)
        throw new ConflictException('This member was just changed; reload');

      await this.history.record(transaction, [
        {
          companyId: target.companyId,
          userId: target.id,
          reason: MembershipChangeReason.MOVED,
          fromRoleId: target.roleId,
          toRoleId: target.roleId,
          fromCornerId: target.companyStoreId,
          toCornerId: dto.cornerId,
          changedByUserId: caller.id,
        },
      ]);
    });

    const event: MemberMovedEvent = {
      memberUserId: target.id,
      changedByUserId: caller.id,
      fromCornerId: target.companyStoreId,
      toCornerId: dto.cornerId,
      reason: 'MOVED',
    };
    this.eventEmitter.emit(NotificationEvent.MEMBER_MOVED, event);

    return this.toView(await this.findRow(target.id));
  }

  /**
   * A member of the caller's company (the admin: of any company) who can be
   * moved or re-roled. Everyone else is "not found": the admin's scope is {},
   * so this also rules out the platform admin and members with no role yet.
   */
  private async findTarget(caller: AuthUser, userId: string) {
    const target = await this.prisma.user.findFirst({
      where: {
        id: userId,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
      select: MEMBER_SELECT,
    });
    const roleCode = target?.role?.code;
    if (
      !target ||
      target.companyId === null ||
      roleCode === undefined ||
      !isMemberRole(roleCode)
    )
      throw new NotFoundException('Member not found');
    return { ...target, companyId: target.companyId, roleCode: roleCode };
  }

  private findRow(userId: string): Promise<MemberRow> {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: MEMBER_SELECT,
    });
  }

  private async toView(row: MemberRow): Promise<MemberView> {
    return {
      id: row.id,
      name: row.name,
      profileImageUrl: row.profileImageUrl
        ? await this.storage.presignGetUrl(row.profileImageUrl)
        : null,
      phone: row.phone,
      contactEmail: row.contactEmail,
      status: row.status,
      role: row.role,
      branch: row.companyStore,
      createdAt: row.createdAt,
    };
  }
}

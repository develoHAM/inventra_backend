import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { AuthProfile } from '../auth/types/auth-profile';
import { ProfileStatus } from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';
import type { CompanyApprovedEvent } from '../notifications/notification-events';
import { generateUniqueJoinCode } from './join-code';
import { MembershipHistoryService } from '../membership-history/membership-history.service';
import { HistoryQueryDto } from '../membership-history/dto/history-query.dto';
import type { MembershipHistoryPage } from '../membership-history/membership-change-view';

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly history: MembershipHistoryService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Platform admin approves a registered company by activating its owner. */
  async approveCompany(companyId: string) {
    const owner = await this.prisma.profile.findFirst({
      where: { companyId: companyId, role: { code: 'OWNER' } },
    });

    if (!owner) throw new NotFoundException('Company owner not found');

    if (owner.status !== ProfileStatus.PENDING_APPROVAL)
      throw new BadRequestException('Owner is not pending approval');

    const approvedOwner = await this.prisma.profile.update({
      where: { id: owner.id },
      data: { status: ProfileStatus.ACTIVE },
    });

    const event: CompanyApprovedEvent = {
      companyId: companyId,
      ownerProfileId: owner.id,
    };
    this.eventEmitter.emit(NotificationEvent.COMPANY_APPROVED, event);

    return approvedOwner;
  }

  /** The code staff type at POST /auth/register/member. */
  async getJoinCode(caller: AuthProfile): Promise<{ joinCode: string }> {
    const companyId = this.requireCompany(caller);
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, deletedAt: null },
      select: { joinCode: true },
    });
    if (!company) throw new NotFoundException('Company not found');
    return { joinCode: company.joinCode };
  }

  /**
   * Replace the code: the old one stops working immediately. Members who
   * already joined are unaffected — the code is only checked at signup.
   */
  async rotateJoinCode(caller: AuthProfile): Promise<{ joinCode: string }> {
    const companyId = this.requireCompany(caller);
    const joinCode = await generateUniqueJoinCode(this.prisma);
    const result = await this.prisma.company.updateMany({
      where: { id: companyId, deletedAt: null },
      data: { joinCode: joinCode },
    });
    if (result.count === 0) throw new NotFoundException('Company not found');
    return { joinCode: joinCode };
  }

  /**
   * The whole company's history, newest first. The admin reads any company;
   * an owner reads their own. Another company is 404 whoever asks (we don't
   * confirm it exists); this company's managers and staff get 403.
   */
  async listHistory(
    caller: AuthProfile,
    companyId: string,
    query: HistoryQueryDto,
  ): Promise<MembershipHistoryPage> {
    const isAdmin = caller.roleCode === 'ADMIN';
    if (!isAdmin && caller.companyId !== companyId)
      throw new NotFoundException('Company not found');
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, deletedAt: null },
      select: { id: true },
    });
    if (!company) throw new NotFoundException('Company not found');
    if (!isAdmin && caller.roleCode !== 'OWNER')
      throw new ForbiddenException('Only owners can read the company history');

    return this.history.page({ companyId: company.id }, query);
  }

  /** The caller's own company id; the platform admin has none. */
  private requireCompany(caller: AuthProfile): string {
    if (!caller.companyId) {
      throw new ForbiddenException('You do not belong to a company');
    }
    return caller.companyId;
  }
}

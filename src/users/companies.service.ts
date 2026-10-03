import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/types/auth-user';
import { generateUniqueJoinCode } from './join-code';

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  /** The code staff type at POST /auth/register/member. */
  async getJoinCode(caller: AuthUser): Promise<{ joinCode: string }> {
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
  async rotateJoinCode(caller: AuthUser): Promise<{ joinCode: string }> {
    const companyId = this.requireCompany(caller);
    const joinCode = await generateUniqueJoinCode(this.prisma);
    const result = await this.prisma.company.updateMany({
      where: { id: companyId, deletedAt: null },
      data: { joinCode: joinCode },
    });
    if (result.count === 0) throw new NotFoundException('Company not found');
    return { joinCode: joinCode };
  }

  /** The caller's own company id; the platform admin has none. */
  private requireCompany(caller: AuthUser): string {
    if (!caller.companyId) {
      throw new ForbiddenException('You do not belong to a company');
    }
    return caller.companyId;
  }
}

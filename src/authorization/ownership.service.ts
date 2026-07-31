import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthUser } from '../auth/types/auth-user';

@Injectable()
export class OwnershipService {
  constructor() {}

  scopeToCompany(user: AuthUser): { companyId?: string } {
    if (user.roleCode === 'ADMIN') {
      return {};
    }

    if (!user.companyId)
      throw new ForbiddenException('User must have a company');

    return { companyId: user.companyId };
  }

  assertOwns(user: AuthUser, resourceCompanyId: string | null): void {
    if (user.roleCode === 'ADMIN') {
      return;
    }

    if (resourceCompanyId !== user.companyId) {
      throw new NotFoundException();
    }
  }
}

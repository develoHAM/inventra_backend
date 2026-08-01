import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthUser } from '../auth/types/auth-user';

@Injectable()
export class OwnershipService {
  constructor() {}

  scopeToCompany(
    user: AuthUser,
    field: string = 'companyId',
  ): Record<string, string> {
    if (user.roleCode === 'ADMIN') {
      return {};
    }

    if (!user.companyId)
      throw new ForbiddenException('User must have a company');

    return { [field]: user.companyId };
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

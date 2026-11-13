import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthProfile } from '../auth/types/auth-profile';

@Injectable()
export class OwnershipService {
  constructor() {}

  scopeToCompany(
    profile: AuthProfile,
    field: string = 'companyId',
  ): Record<string, string> {
    if (profile.roleCode === 'ADMIN') {
      return {};
    }

    if (!profile.companyId)
      throw new ForbiddenException('User must have a company');

    return { [field]: profile.companyId };
  }

  assertOwns(profile: AuthProfile, resourceCompanyId: string | null): void {
    if (profile.roleCode === 'ADMIN') {
      return;
    }

    if (resourceCompanyId !== profile.companyId) throw new NotFoundException();
  }

  resolveTargetCompany(
    caller: AuthProfile,
    requestedCompanyId?: string,
  ): string {
    const companyId =
      caller.roleCode === 'ADMIN' ? requestedCompanyId : caller.companyId;
    if (!companyId) throw new BadRequestException('companyId is required');
    return companyId;
  }
}

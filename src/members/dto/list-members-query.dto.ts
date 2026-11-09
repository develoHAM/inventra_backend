import { IsEnum, IsIn, IsOptional, IsUUID, ValidateIf } from 'class-validator';
import { UserStatus } from '../../generated/prisma/enums';
import { MEMBER_ROLES } from '../member-rules';
import type { MemberRoleCode } from '../member-rules';

export class ListMembersQueryDto {
  // Only the admin's is used; everyone else always gets their own company.
  @IsOptional()
  @IsUUID()
  companyId?: string;

  // A branch id, or the word "none" for people with no branch: a URL can't
  // carry null (?cornerId=null would be the text "null").
  @IsOptional()
  @ValidateIf((query: ListMembersQueryDto) => query.cornerId !== 'none')
  @IsUUID()
  cornerId?: string;

  @IsOptional()
  @IsIn([...MEMBER_ROLES])
  role?: MemberRoleCode;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}

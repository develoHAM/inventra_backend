import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { MEMBER_ROLES } from '../member-rules';
import type { MemberRoleCode } from '../member-rules';

export class ChangeRoleDto {
  @IsIn([...MEMBER_ROLES])
  role!: MemberRoleCode;

  // Only when demoting an owner: the branch they land in. Not sent, or
  // null, means no branch. IsOptional lets both null and "not sent"
  // through; decideRoleChange refuses a sent one (even null) for any other
  // change.
  @IsOptional()
  @IsUUID()
  cornerId?: string | null;
}

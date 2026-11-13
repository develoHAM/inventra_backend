import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { MEMBER_ROLES } from '../member-rules';
import type { MemberRoleCode } from '../member-rules';

export class ChangeRoleDto {
  @IsIn([...MEMBER_ROLES])
  role!: MemberRoleCode;

  // Only for the admin demoting an owner: where the person lands (null = no
  // branch). IsOptional lets both null and "not sent" through; the service
  // tells them apart with `!== undefined`.
  @IsOptional()
  @IsUUID()
  cornerId?: string | null;
}

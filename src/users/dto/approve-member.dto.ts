import { IsInt, IsPositive } from 'class-validator';

export class ApproveMemberDto {
  @IsInt()
  @IsPositive()
  roleId!: number; // the role to assign the member (MANAGER or STAFF)
}

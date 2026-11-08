import { IsInt, IsPositive, IsUUID, ValidateIf } from 'class-validator';

export class ApproveMemberDto {
  @IsInt()
  @IsPositive()
  roleId!: number; // the role to give the member: MANAGER or STAFF

  // Required, but may be null ("no branch yet"). ValidateIf skips the uuid
  // check only for null; a missing field still fails it.
  @ValidateIf((dto: ApproveMemberDto) => dto.cornerId !== null)
  @IsUUID()
  cornerId!: string | null;
}

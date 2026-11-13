import { IsInt, IsPositive, IsUUID, ValidateIf } from 'class-validator';

export class ApproveProfileDto {
  @IsInt()
  @IsPositive()
  roleId!: number; // the role to give the member: MANAGER or STAFF

  // Required, but may be null ("no branch yet"). ValidateIf skips the uuid
  // check only for null; a missing field still fails it.
  @ValidateIf((dto: ApproveProfileDto) => dto.cornerId !== null)
  @IsUUID()
  cornerId!: string | null;
}

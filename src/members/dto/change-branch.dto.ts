import { IsUUID, ValidateIf } from 'class-validator';

export class ChangeBranchDto {
  // Required, but may be null ("no branch"). ValidateIf skips the uuid
  // check only for null; a missing field still fails it.
  @ValidateIf((dto: ChangeBranchDto) => dto.cornerId !== null)
  @IsUUID()
  cornerId!: string | null;
}

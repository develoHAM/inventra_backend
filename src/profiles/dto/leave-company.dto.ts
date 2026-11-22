import { IsOptional, IsUUID } from 'class-validator';

export class LeaveCompanyDto {
  // Only for the last ACTIVE owner: who takes over. Left out or null, the
  // system picks (managers first, then the longest-serving). IsOptional lets
  // null through as well as a missing field, so the type says both.
  @IsOptional()
  @IsUUID()
  ownerSuccessorProfileId?: string | null;
}

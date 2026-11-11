import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** Entries per page when the app doesn't say. */
export const DEFAULT_HISTORY_LIMIT = 50;

/** `?limit=&cursor=` on the three history routes. */
export class HistoryQueryDto {
  // A URL carries text: @Type turns "20" into 20 before the checks run.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  // The bookmark: the id of the last entry the previous page showed.
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

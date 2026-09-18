import { IsOptional, IsIn } from 'class-validator';

export type ExportLanguage = 'en' | 'ko';
export class ExportQueryDto {
  @IsOptional()
  @IsIn(['csv', 'xlsx'])
  format?: 'csv' | 'xlsx';

  @IsOptional()
  @IsIn(['en', 'ko'])
  lang?: ExportLanguage;
}

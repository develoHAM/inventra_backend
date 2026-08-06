import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateBrandDto } from './create-brand.dto';

export class UpdateBrandDto extends PartialType(
  OmitType(CreateBrandDto, ['companyId'] as const),
  {
    skipNullProperties: false,
  },
) {}

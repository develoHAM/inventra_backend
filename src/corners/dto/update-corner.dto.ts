import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateCornerDto } from './create-corner.dto';

export class UpdateCornerDto extends PartialType(
  OmitType(CreateCornerDto, ['companyId', 'storeId', 'managerUserId'] as const),
) {}

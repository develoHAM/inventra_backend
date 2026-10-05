import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { DevicePlatform } from '../../generated/prisma/enums';

export class RegisterDeviceDto {
  // the FCM registration token the app got from the Firebase SDK
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;

  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;
}

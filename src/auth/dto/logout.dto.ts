import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LogoutDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;

  // The app's FCM token: send it to stop this device receiving the user's
  // pushes after logout. The web console may omit it.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  deviceToken?: string;
}

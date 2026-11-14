import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class SwitchProfileDto {
  // The session to rotate: the new refresh token will remember the new profile.
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;

  // One of the caller's own company profiles (from the `companies` list).
  @IsUUID()
  profileId!: string;
}

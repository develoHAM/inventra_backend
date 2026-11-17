import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * PATCH /profiles/me: your name in the company that's open. Only the name:
 * the contact email needs a proof (PUT /profiles/me/contact-email), and
 * role or status are never yours to set.
 */
export class UpdateProfileDto {
  // profiles.name is VARCHAR(100)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;
}

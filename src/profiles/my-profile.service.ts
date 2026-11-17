import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { EmailVerificationService } from '../email-verification/email-verification.service';
import type { AuthProfile } from '../auth/types/auth-profile';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SetContactEmailDto } from './dto/set-contact-email.dto';

/** What /profiles/me answers: who you are in this company. */
export const PROFILE_SUMMARY_SELECT = {
  id: true,
  name: true,
  contactEmail: true,
} satisfies Prisma.ProfileSelect;

export type ProfileSummary = Prisma.ProfileGetPayload<{
  select: typeof PROFILE_SUMMARY_SELECT;
}>;

/**
 * The open profile edits itself: its name and its contact email in this
 * company. "Me" is always request.profile (checked by the guard on this
 * request), never an id from the client.
 */
@Injectable()
export class MyProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  /** Your name in this company only; your other companies keep theirs. */
  updateMyProfile(
    caller: AuthProfile,
    dto: UpdateProfileDto,
  ): Promise<ProfileSummary> {
    return this.prisma.profile.update({
      where: { id: caller.id },
      data: { name: dto.name },
      select: PROFILE_SUMMARY_SELECT,
    });
  }

  /**
   * Where this company's notifications go. The proof is spent and the
   * address written in ONE transaction: a bad or used proof throws, the
   * transaction rolls back, and nothing is written.
   */
  setMyContactEmail(
    caller: AuthProfile,
    dto: SetContactEmailDto,
  ): Promise<ProfileSummary> {
    return this.prisma.$transaction(async (transaction) => {
      // the token works only for the address it was issued for, once
      await this.emailVerification.consume(transaction, {
        token: dto.emailVerificationToken,
        email: dto.email,
      });
      return transaction.profile.update({
        where: { id: caller.id },
        data: { contactEmail: dto.email },
        select: PROFILE_SUMMARY_SELECT,
      });
    });
  }
}

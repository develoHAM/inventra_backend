import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import {
  PhoneVerificationPurpose,
  ProfileStatus,
} from '../generated/prisma/enums';
import { PhoneVerificationService } from '../phone-verification/phone-verification.service';
import { LeavingService } from '../profiles/leaving.service';
import type { LeaveOutcome } from '../profiles/leaving.service';
import { ProviderDisconnectService } from '../social-auth/provider-disconnect.service';
import { AccountsService } from '../accounts/accounts.service';
import type { AuthAccount } from '../auth/types/auth-account';
import { DeleteAccountDto } from './dto/delete-account.dto';

/**
 * DELETE /me: the sign-in goes, and with it every company membership,
 * login method, session and device. The profiles stay (DEACTIVATED), so
 * names remain on the records they made.
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly phoneVerification: PhoneVerificationService,
    private readonly leaving: LeavingService,
    private readonly disconnect: ProviderDisconnectService,
    private readonly accounts: AccountsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async deleteAccount(
    account: AuthAccount,
    dto: DeleteAccountDto,
  ): Promise<void> {
    // The platform admin runs the platform, and has no phone to prove.
    if (await this.accounts.isPlatformAdmin(account.accountId)) {
      throw new ForbiddenException(
        'The platform admin cannot delete its account',
      );
    }

    const { events, loginMethods } = await this.prisma.$transaction(
      async (transaction) => {
        const now = new Date();

        // 1. The account lock, before anything else (the lock order is
        // account → company → branches → profiles), on a live account only.
        // A second deletion, or a link, waits here; a deletion that waited
        // then matches nothing.
        const [locked] = await transaction.account.updateManyAndReturn({
          where: { id: account.accountId, deletedAt: null },
          data: { updatedAt: now },
          select: { phone: true },
        });
        if (!locked) {
          throw new UnauthorizedException(); // deleted since the guard let this request in
        }
        if (locked.phone === null) {
          // only the seeded admin has no phone, and it was refused above
          throw new ForbiddenException(
            'The platform admin cannot delete its account',
          );
        }

        // 2. The proof: this account's own phone, for this purpose, once.
        // Spent inside the transaction: if a later step fails, it is
        // given back with everything else.
        await this.phoneVerification.consume(transaction, {
          token: dto.phoneVerificationToken,
          phone: locked.phone,
          purpose: PhoneVerificationPurpose.DELETE_ACCOUNT,
        });

        // 3. Leave every company it is still in, by the same rules as
        // leaving; the system picks any owner successor. In companyId order:
        // two deletions that share companies lock them in the same order,
        // so neither waits for the other forever.
        const profiles = await transaction.profile.findMany({
          where: {
            accountId: account.accountId,
            deletedAt: null,
            status: { not: ProfileStatus.DEACTIVATED },
          },
          orderBy: { companyId: 'asc' },
          select: { id: true, companyId: true },
        });
        const events: LeaveOutcome['events'] = [];
        for (const profile of profiles) {
          if (profile.companyId === null) {
            continue; // only the admin's profile has no company
          }
          const outcome = await this.leaving.leaveInTransaction(transaction, {
            profileId: profile.id,
            companyId: profile.companyId,
            actorProfileId: profile.id, // they did it themselves
            reason: 'ACCOUNT_DELETED',
          });
          events.push(...outcome.events);
        }

        // 4. The login methods: read first (the disconnects after the
        // commit need them), then deleted. Their unique rules count every
        // row, so only deleting frees each identity and the password email.
        const loginMethods = await transaction.accountLoginMethod.findMany({
          where: { accountId: account.accountId },
          select: {
            id: true,
            method: true,
            providerUserId: true,
            refreshToken: true,
          },
        });
        await transaction.accountLoginMethod.deleteMany({
          where: { accountId: account.accountId },
        });

        // 5. Every session ends: no refresh token gets new access tokens.
        await transaction.refreshToken.updateMany({
          where: { accountId: account.accountId, revokedAt: null },
          data: { revokedAt: now },
        });

        // 6. No more pushes to their phones.
        await transaction.deviceToken.deleteMany({
          where: { accountId: account.accountId },
        });

        // 7. The account itself. The guard reads deletedAt on every request,
        // so each old access token is refused from now on, and
        // UQ_accounts_phone counts live accounts only, so the phone is free.
        await transaction.account.update({
          where: { id: account.accountId },
          data: { deletedAt: now, lastProfileId: null },
        });

        return { events: events, loginMethods: loginMethods };
      },
    );

    // Only now, after the commit: never announce a deletion that rolled back,
    // and never make a provider forget an account that still exists.
    for (const event of events) {
      this.eventEmitter.emit(event.name, event.payload);
    }
    for (const loginMethod of loginMethods) {
      await this.disconnect.disconnectQuietly(loginMethod); // never throws
    }
  }
}

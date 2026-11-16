import { Body, Controller, Get, Post } from '@nestjs/common';
import { AccountRoute } from '../auth/decorators/account-route.decorator';
import { CurrentAccount } from '../auth/decorators/current-account.decorator';
import type { AuthAccount } from '../auth/types/auth-account';
import { AccountsService } from './accounts.service';
import { AccountCompaniesService } from './account-companies.service';
import type { CompanyProfileView } from './company-profile-view';
import { JoinCompanyDto } from './dto/join-company.dto';
import { CreateCompanyDto } from './dto/create-company.dto';

/**
 * The signed-in account's companies. Every route is an @AccountRoute(): it
 * works with no company open, which is the state a new signup lands in.
 */
@AccountRoute()
@Controller('me')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly accountCompanies: AccountCompaniesService,
  ) {}

  /** The company dropdown: every profile this account can open. */
  @Get('companies')
  listCompanies(
    @CurrentAccount() account: AuthAccount,
  ): Promise<CompanyProfileView[]> {
    return this.accounts.listCompanies(account.accountId);
  }

  /** Ask to join a company by its invite code → 201, waiting for approval. */
  @Post('companies/join')
  join(
    @CurrentAccount() account: AuthAccount,
    @Body() dto: JoinCompanyDto,
  ): Promise<CompanyProfileView> {
    return this.accountCompanies.join(account, dto);
  }

  /** Register a new company, owned by this account → 201, waiting for the admin. */
  @Post('companies')
  create(
    @CurrentAccount() account: AuthAccount,
    @Body() dto: CreateCompanyDto,
  ): Promise<CompanyProfileView> {
    return this.accountCompanies.create(account, dto);
  }
}

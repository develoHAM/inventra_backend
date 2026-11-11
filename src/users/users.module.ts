import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { CompaniesController } from './companies.controller';
import { UsersService } from './users.service';
import { AuthorizationModule } from '../authorization/authorization.module';
import { CompaniesService } from './companies.service';
import { MembershipHistoryModule } from '../membership-history/membership-history.module';

@Module({
  imports: [AuthorizationModule, MembershipHistoryModule],
  controllers: [UsersController, CompaniesController],
  providers: [UsersService, CompaniesService],
  exports: [UsersService],
})
export class UsersModule {}

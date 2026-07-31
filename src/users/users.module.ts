import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { CompaniesController } from './companies.controller';
import { UsersService } from './users.service';
import { AuthorizationModule } from '../authorization/authorization.module';

@Module({
  imports: [AuthorizationModule],
  controllers: [UsersController, CompaniesController],
  providers: [UsersService],
})
export class UsersModule {}

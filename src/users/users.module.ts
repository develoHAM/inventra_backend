import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { CompaniesController } from './companies.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController, CompaniesController],
  providers: [UsersService],
})
export class UsersModule {}

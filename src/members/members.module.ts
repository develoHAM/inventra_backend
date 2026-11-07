import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { CornersModule } from '../corners/corners.module';
import { MembershipHistoryModule } from '../membership-history/membership-history.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  imports: [AuthorizationModule, CornersModule, MembershipHistoryModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}

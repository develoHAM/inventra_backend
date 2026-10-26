import { Module } from '@nestjs/common';
import { SignupTicketService } from './signup-ticket.service';

/**
 * Its own module so both sides can import it without importing each other:
 * SocialAuthModule creates tickets (and uses AuthModule for sessions), and
 * AuthModule will spend them at signup (Task 12).
 */
@Module({
  providers: [SignupTicketService],
  exports: [SignupTicketService],
})
export class SignupTicketsModule {}

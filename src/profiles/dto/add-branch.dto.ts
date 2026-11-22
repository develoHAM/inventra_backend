import { IsUUID } from 'class-validator';

export class AddBranchDto {
  // The branch to add them to. Taking someone off a branch is
  // DELETE /profiles/:id/branches/:cornerId, so null means nothing here.
  @IsUUID()
  cornerId!: string;
}

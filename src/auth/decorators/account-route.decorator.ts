import { SetMetadata } from '@nestjs/common';

export const ACCOUNT_ROUTE_KEY = 'isAccountRoute';

/**
 * A route about the sign-in itself (sign out, switch company, devices, login
 * methods): it works with no company open. Every other signed-in route is a
 * company route, and a token with no profile open gets 403 there. Put it on
 * a handler or on a whole controller.
 */
export const AccountRoute = () => SetMetadata(ACCOUNT_ROUTE_KEY, true);

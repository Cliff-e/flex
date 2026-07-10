/**
 * Login redirect helper.
 *
 * Previously this module built a legacy Deriv implicit-flow OAuth URL
 * directly in the browser. That flow has been removed.
 *
 * All OAuth initiation now goes through the DigitalOcean backend via
 * initiateDerivAuth() (src/utils/pkce.ts), which generates PKCE server-side
 * and redirects the user to Deriv. This file is kept only to preserve the
 * import contract for callers that use redirectToLogin().
 */
import { initiateDerivAuth, LOGIN_URL } from '@/utils/pkce';

/**
 * Redirect the user to login via the DigitalOcean backend OAuth flow.
 * All callers of the legacy redirectToLogin() are served by this wrapper.
 */
export const redirectToLogin = async (): Promise<void> => {
    await initiateDerivAuth();
};

/**
 * @deprecated — use redirectToLogin() instead.
 * Returns the DO backend login URL for any callers that read loginUrl directly.
 */
export const loginUrl = (): string => LOGIN_URL;

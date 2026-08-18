/**
 * Authentication entry-point — DigitalOcean backend.
 *
 * All PKCE generation, Deriv OAuth URL construction, and code exchange are
 * handled server-side by the DigitalOcean backend. The frontend's sole
 * responsibility is:
 *
 *   1. Redirect the browser to the backend login endpoint (initiateDerivAuth).
 *   2. Receive ?auth_code= on the /auth/callback route (CallbackPage).
 *   3. Exchange it for the real access_token via POST /api/auth/exchange.
 *   4. Persist credentials and account list via AuthSessionManager.
 *
 * VITE_API_BASE_URL must point to the DigitalOcean backend URL.
 * For Vercel deployments, set this in the Vercel project environment variables.
 */

/** Base URL for the DigitalOcean API backend. Set via VITE_API_BASE_URL. */
export const API_BASE_URL: string = (process.env.VITE_API_BASE_URL as string) ?? '';

/** Backend login entry point — starts the server-side PKCE OAuth flow. */
export const LOGIN_URL = `${API_BASE_URL}/api/auth/login`;

/**
 * Redirect the user to the DigitalOcean backend OAuth login endpoint.
 *
 * The backend generates the PKCE verifier/challenge, builds the Deriv
 * authorization URL, and redirects the user to Deriv. After the user
 * authenticates, the backend handles the code exchange and redirects back
 * to ${window.origin}/auth/callback?auth_code=<one-time-code>.
 * CallbackPage then exchanges the auth_code for the real access_token.
 */
export async function initiateDerivAuth(): Promise<void> {
    window.location.href = LOGIN_URL;
}

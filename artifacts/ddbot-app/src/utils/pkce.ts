/**
 * Authentication entry-point — DigitalOcean backend.
 *
 * All PKCE generation, Deriv OAuth URL construction, and code exchange are
 * handled server-side. The frontend's sole responsibility is:
 *
 *   1. Redirect the browser to the backend login endpoint (initiateDerivAuth).
 *   2. Receive ?access_token= on the /auth/callback route (CallbackPage).
 *   3. Persist credentials and account list via AuthSessionManager.
 *
 * There is no client-side PKCE, no client-side code exchange, and no
 * Railway, Vercel, or any other third-party backend dependency.
 */

/** Base URL for the DigitalOcean API backend. Set via VITE_API_BASE_URL. */
export const API_BASE_URL: string = (process.env.VITE_API_BASE_URL as string) ?? '';

/** Backend login entry point — starts the server-side PKCE OAuth flow. */
export const LOGIN_URL = `${API_BASE_URL}/api/auth/login`;

/**
 * Redirect the user to the backend OAuth login endpoint.
 *
 * The backend generates the PKCE verifier/challenge, builds the Deriv
 * authorization URL, and redirects the user to Deriv. After the user
 * authenticates on Deriv, the backend handles the code exchange and
 * redirects back to ${window.origin}/auth/callback?access_token=...
 */
export async function initiateDerivAuth(): Promise<void> {
    window.location.href = LOGIN_URL;
}
// deploy trigger 1783599035

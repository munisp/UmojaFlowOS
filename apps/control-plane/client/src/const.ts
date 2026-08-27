export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Start the server-owned OpenID Connect authorization-code flow from an event
// handler. State, nonce, PKCE, token exchange, and session-cookie creation stay
// on the server so browser code never receives a client secret.
export const startLogin = () => {
  window.location.assign("/auth/login");
};

// Ends both the app's own session and the identity provider's SSO session.
// Clearing only the local cookie leaves the browser silently re-authenticated
// on the next login attempt.
export const startLogout = () => {
  window.location.assign("/auth/logout");
};

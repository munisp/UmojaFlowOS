export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Start the server-owned OpenID Connect authorization-code flow from an event
// handler. State, nonce, PKCE, token exchange, and session-cookie creation stay
// on the server so browser code never receives a client secret.
export const startLogin = () => {
  window.location.assign("/auth/login");
};

import { describe, expect, it } from "vitest";
import { mapKeycloakClaims, requireKeycloakRole } from "./keycloakClaims";

describe("Keycloak role mapping", () => {
  it("maps only explicit UmojaFlowOS operating roles", () => {
    expect(mapKeycloakClaims({ sub: "kc-user", realm_access: { roles: ["admin", "unknown"] } }).roles).toEqual(["admin"]);
  });
  it("fails closed for missing subject and absent required role", () => {
    expect(() => mapKeycloakClaims({})).toThrow("subject");
    expect(() => requireKeycloakRole({ sub: "kc-user", realm_access: { roles: ["auditor"] } }, "admin")).toThrow("not authorized");
  });
});

import { randomBytes } from "node:crypto";
import { createOperatorAccount } from "./keycloakAdmin";
import { createPostgresCustomer, type Actor } from "./postgres";
import { grantOperatingRole } from "./operatorRoleGrants";
import { assignExternalStakeholder } from "./externalStakeholders";
import { legacyOperatingRoles, type OperatingRole } from "./operatingRoles";

// Creates the identity provider account, a linked customer record so the
// person can immediately be run through the same KYC evidence and review
// workflow every other subject on this platform goes through, and grants the
// requested operating role. The account is created before anything else: if
// the Postgres steps fail afterward, the account still exists and the person
// falls back into the ordinary "pending access" queue on first sign-in, where
// an administrator can grant the role from there instead.
export async function onboardOperator(actor: Actor, input: { name: string; email: string; role: OperatingRole; counterpartyId?: string; dossierId?: string }) {
  const account = await createOperatorAccount({ name: input.name, email: input.email });

  const customer = await createPostgresCustomer(actor, {
    legalName: input.name,
    registrationIdentifier: `OPERATOR-${randomBytes(4).toString("hex")}`,
  });

  if (legacyOperatingRoles.has(input.role)) {
    await grantOperatingRole(actor, { subject: account.subject, role: input.role });
  } else {
    await assignExternalStakeholder(actor, { role: input.role as "provider_contact" | "cbn_liaison", stakeholderSubject: account.subject, counterpartyId: input.counterpartyId, dossierId: input.dossierId });
  }

  return { subject: account.subject, initialPassword: account.initialPassword, customerId: customer.id };
}

import assert from "node:assert/strict";
import { checksum, deterministicUuid, mapRoles } from "./cutover-lib.mjs";

const first = deterministicUuid("customers", 17);
assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
assert.equal(first, deterministicUuid("customers", 17));
assert.notEqual(first, deterministicUuid("customers", 18));
assert.equal(checksum({ b: 2, a: 1 }), checksum({ a: 1, b: 2 }));
assert.deepEqual(mapRoles([{ openId: "z", role: "auditor" }, { openId: "a", role: "admin" }]), [{ userSubject: "a", role: "admin" }, { userSubject: "z", role: "auditor" }]);
assert.throws(() => mapRoles([{ openId: "invalid", role: "operator" }]), /no canonical PostgreSQL operating-role mapping/);
process.stdout.write("cutover-lib regressions passed\n");

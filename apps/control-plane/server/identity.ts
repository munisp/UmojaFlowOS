export type PlatformIdentityRole = "admin" | "compliance_officer" | "treasury_operator" | "auditor";

export type PlatformIdentity = {
  id: number;
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: string | null;
  role: PlatformIdentityRole;
  createdAt: Date;
  updatedAt: Date;
  lastSignedIn: Date;
};

export const ENV = {
  sessionSecret: process.env.UMOJA_SESSION_SECRET ?? "",
  postgresDatabaseUrl: process.env.POSTGRES_DATABASE_URL ?? "",
  bootstrapAdministratorSubject: process.env.UMOJA_BOOTSTRAP_ADMINISTRATOR_SUBJECT ?? "",
  isProduction: process.env.NODE_ENV === "production",
};

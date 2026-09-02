import "dotenv/config";
import "./otel";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOidcRoutes } from "./oidc";
import { registerStorageProxy } from "./storageProxy";
import { registerInternalLedgerProjection } from "../internalLedgerProjection";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { regulatoryDeadlineReminders } from "../scheduled/regulatoryDeadlineReminders";
import { counterpartyRiskReviews } from "../scheduled/counterpartyRiskReviews";
import { serviceHealthCollector } from "../scheduled/serviceHealthCollector";
import { startServiceHealthMonitor } from "../serviceHealthMonitor";
import { startSegregationOfDutiesMonitor } from "../segregationOfDutiesMonitor";
import { lakehouseControlEvidenceDrain } from "../scheduled/lakehouseControlEvidenceDrain";
import { serveStatic, setupVite } from "./vite";
import { trace } from "@opentelemetry/api";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  app.use((req, _res, next) => {
    const span = trace.getActiveSpan();
    const tenantId = req.header("x-tenant-id");
    if (span && tenantId) span.setAttribute("tenant.id", tenantId.slice(0, 128));
    if (span) span.setAttribute("umoja.request.path", req.path);
    next();
  });
  // The payment engine signs the raw ledger-evidence body. Register this
  // private route before the general JSON parser so its HMAC covers exactly the
  // bytes received from the protected network.
  app.use("/internal/ledger/projections", express.raw({ type: "application/json", limit: "64kb" }));
  registerInternalLedgerProjection(app);
  // Configure body parser with larger size limit for file uploads.
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOidcRoutes(app);
  app.post("/api/scheduled/regulatory-deadline-reminders", regulatoryDeadlineReminders);
  app.post("/api/scheduled/counterparty-risk-reviews", counterpartyRiskReviews);
  app.post("/api/scheduled/service-health-collector", serviceHealthCollector);
  app.post("/api/scheduled/lakehouse-control-evidence-drain", lakehouseControlEvidenceDrain);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const development = process.env.NODE_ENV === "development";
  const port = development ? await findAvailablePort(preferredPort) : preferredPort;
  if (!development && !(await isPortAvailable(preferredPort))) {
    throw new Error(`Configured production PORT ${preferredPort} is already in use; refusing an undiscoverable fallback port`);
  }
  if (development && port !== preferredPort) {
    console.log(`Development port ${preferredPort} is busy, using ${port}`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    const healthMonitor = startServiceHealthMonitor();
    if (healthMonitor) server.once("close", healthMonitor.stop);
    const segregationOfDutiesMonitor = startSegregationOfDutiesMonitor();
    if (segregationOfDutiesMonitor) server.once("close", segregationOfDutiesMonitor.stop);
  });
}

startServer().catch(console.error);

import type { Express, Request, Response } from "express";
import { storageGetSignedUrl } from "../storage";

export function registerStorageProxy(app: Express) {
  app.get("/storage/*", async (req: Request, res: Response) => {
    const key = req.params[0];
    if (!key) {
      res.status(400).json({ error: "object key is required" });
      return;
    }

    try {
      const url = await storageGetSignedUrl(key);
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch {
      res.status(404).json({ error: "object unavailable" });
    }
  });
}

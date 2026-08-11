// HTTP Basic auth for the whole web server.
//
// The agent behind this API can run shell commands and read the filesystem, so
// the public deployment must not be open. Browsers handle the credential prompt
// natively, which is why Basic rather than a login page.

import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const USER = process.env.LOGIN_USER;
const PASSWORD = process.env.LOGIN_PASSWORD;

/**
 * Left open so a deploy can go out.
 *
 * kamal-proxy health-checks the app before routing traffic to it, unauthenticated
 * — a 401 here reads as "container never came up" and the deploy rolls back.
 */
const OPEN_PATHS = new Set(["/health", "/up"]);

const REALM = 'Basic realm="my-ai-agent", charset="UTF-8"';

/**
 * Compare via digests: `timingSafeEqual` throws on length mismatch, and hashing
 * first makes both sides the same size without leaking length through timing.
 */
const digest = (value: string) => createHash("sha256").update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

const credentialsFrom = (header: string): [string, string] | null => {
  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return null;

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return null;

  // Split on the first colon only — a password may legitimately contain one.
  return [decoded.slice(0, separator), decoded.slice(separator + 1)];
};

const guard = (req: Request, res: Response, next: NextFunction) => {
  if (OPEN_PATHS.has(req.path)) return next();

  const credentials = credentialsFrom(req.get("authorization") ?? "");
  if (credentials && equal(credentials[0], USER!) && equal(credentials[1], PASSWORD!)) {
    return next();
  }

  res.set("www-authenticate", REALM);
  res.status(401).json({ error: "Authentication required" });
};

const configured = Boolean(USER && PASSWORD);

// Refuse to boot rather than serve an agent with shell access to the internet.
if (!configured && process.env.NODE_ENV === "production") {
  throw new Error(
    "LOGIN_USER and LOGIN_PASSWORD must be set in production — the API exposes " +
      "an agent that can run shell commands."
  );
}

if (!configured) {
  console.warn("LOGIN_USER/LOGIN_PASSWORD unset: the server is UNAUTHENTICATED.");
}

export const basicAuth = configured ? guard : (_req: Request, _res: Response, next: NextFunction) => next();

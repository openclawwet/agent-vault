import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const token = value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : req.headers["x-agent-vault-token"];
  const provided = Array.isArray(token) ? token[0] : token;
  return provided;
}

export function isSameToken(provided: string, expectedToken: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expectedToken);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const provided = extractBearerToken(req);

  if (!provided) {
    return false;
  }

  return isSameToken(provided, expectedToken);
}

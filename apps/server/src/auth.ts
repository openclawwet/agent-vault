import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const token = value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : req.headers["x-agent-vault-token"];
  const provided = Array.isArray(token) ? token[0] : token;

  if (!provided) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expectedToken);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

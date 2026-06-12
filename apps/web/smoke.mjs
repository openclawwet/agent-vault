import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAgentVaultServer } from "@agent-vault/server";
import { chromium } from "playwright";
import { preview } from "vite";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function closePreview(server) {
  await new Promise((resolve, reject) => {
    server.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

function previewUrl(server) {
  const urls = server.resolvedUrls?.local;
  if (urls?.[0]) {
    return urls[0].replace(/\/$/, "");
  }

  const address = server.httpServer.address();
  assert(address && typeof address === "object", "Vite preview address missing.");
  return `http://127.0.0.1:${address.port}`;
}

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-vault-web-smoke-"));
const token = `web-smoke-${randomBytes(16).toString("hex")}`;
const started = await startAgentVaultServer({
  host: "127.0.0.1",
  port: 0,
  homeDir: tempRoot,
  storageRoot: path.join(tempRoot, "storage"),
  dbPath: path.join(tempRoot, "agent-vault.sqlite"),
  token,
});

let previewServer;
let browser;

try {
  const deviceResponse = await fetch(`${started.url}/devices`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "phone-smoke",
      scopes: [
        { space: "Inbox", permissions: ["read", "write"] },
        { space: "Projects", permissions: ["read"] },
      ],
    }),
  });
  assert(deviceResponse.status === 201, `phone device create failed with ${deviceResponse.status}`);
  const deviceJson = await deviceResponse.json();
  assert(typeof deviceJson.token === "string", "phone token missing");

  const uploadPath = path.join(tempRoot, "phone-note.txt");
  await writeFile(uploadPath, "hello from phone pwa smoke\n");

  previewServer = await preview({
    root: appRoot,
    logLevel: "silent",
    preview: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
    },
  });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    acceptDownloads: true,
    viewport: { width: 390, height: 844 },
  });

  await page.goto(previewUrl(previewServer), { waitUntil: "networkidle" });
  await page.fill("#server-url", started.url);
  await page.fill("#device-token", deviceJson.token);
  await page.click(".primary-action");
  await page.waitForSelector(".vault-shell");

  const headline = await page.textContent(".topbar h1");
  assert(headline?.trim() === "Inbox", "Inbox should be the active phone space.");

  const tabTexts = await page.locator(".space-tab span").allTextContents();
  assert(tabTexts.includes("Inbox"), "Inbox tab missing.");
  assert(tabTexts.includes("Projects"), "Projects tab missing.");
  assert(!tabTexts.includes("Archive"), "Unscoped Archive tab should not be visible.");

  await page.setInputFiles("#file-input", uploadPath);
  await page.waitForSelector(".notice.success");
  const notice = await page.textContent(".notice.success");
  assert(notice?.includes("phone-note.txt"), "Upload success should include target path.");

  await page.waitForSelector(".file-row");
  await page.click(".file-row");
  await page.waitForSelector(".text-preview");
  await page.waitForFunction(() => document.querySelector(".text-preview")?.textContent?.includes("hello from phone pwa smoke"));

  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download-file")]);
  assert(download.suggestedFilename() === "phone-note.txt", "Download filename mismatch.");

  const fitsMobileWidth = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert(fitsMobileWidth, "Phone viewport has horizontal overflow.");

  console.log("Agent Vault web phone smoke passed.");
} finally {
  if (browser) {
    await browser.close();
  }
  if (previewServer) {
    await closePreview(previewServer);
  }
  await started.close();
  await rm(tempRoot, { recursive: true, force: true });
}

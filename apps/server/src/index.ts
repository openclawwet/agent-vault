import { isMainModule, startAgentVaultServer } from "./server.js";

export { createAgentVaultApp, startAgentVaultServer } from "./server.js";

if (isMainModule(import.meta.url)) {
  const started = await startAgentVaultServer();
  console.log(`Agent Vault listening on ${started.url}`);
  console.log(`Storage root: ${started.app.config.storageRoot}`);
  console.log(`SQLite DB: ${started.app.config.dbPath}`);
}

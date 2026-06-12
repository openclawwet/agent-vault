#!/usr/bin/env node
import { initConfig, loadConfig } from "./config.js";
import { openNativeDesktopApp } from "./nativeApp.js";
import { watchAllSources } from "./autoSync.js";
import { pullCommand, pushCommand, scanCommand, statusCommand } from "./syncCommands.js";
import { startDesktopUi } from "./uiServer.js";

function flags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

const [command = "status", ...rest] = process.argv.slice(2);
const options = flags(rest);

if (command === "init") {
  if (!options.server || !options.token) {
    throw new Error("init requires --server and --token.");
  }
  const { configPath, config } = await initConfig({
    serverUrl: options.server,
    token: options.token,
    localDir: options.dir,
    space: options.space,
    configPath: options.config,
  });
  console.log(`Agent Vault sync config written to ${configPath}`);
  console.log(`Local folder: ${config.localDir}`);
} else {
  const config = await loadConfig(options.config);

  if (command === "scan") {
    const files = await scanCommand(config);
    console.log(JSON.stringify({ files }, null, 2));
  } else if (command === "status") {
    const status = await statusCommand(config);
    console.log(JSON.stringify(status, null, 2));
  } else if (command === "push") {
    console.log(JSON.stringify(await pushCommand(config), null, 2));
  } else if (command === "pull") {
    console.log(JSON.stringify(await pullCommand(config), null, 2));
  } else if (command === "watch") {
    await watchAllSources(config);
  } else if (command === "serve-ui") {
    const started = await startDesktopUi(config, {
      port: options.port ? Number.parseInt(options.port, 10) : undefined,
      open: false,
    });
    console.log(`Agent Vault desktop UI: ${started.url}`);
    process.once("SIGINT", () => {
      void started.close().finally(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void started.close().finally(() => process.exit(0));
    });
    await new Promise(() => undefined);
  } else if (command === "ui") {
    const noOpen = options.open === "false" || options["no-open"] === "true";
    const useBrowser = options.browser === "true" || options.web === "true";
    if (!noOpen && !useBrowser) {
      const appPath = await openNativeDesktopApp({ appPath: options.app });
      if (appPath) {
        console.log(`Agent Vault app opened: ${appPath}`);
      } else {
        console.warn("Agent Vault app is not installed yet. Falling back to browser UI.");
      }
      if (appPath) {
        process.exit(0);
      }
    }
    const started = await startDesktopUi(config, {
      port: options.port ? Number.parseInt(options.port, 10) : undefined,
      open: !noOpen,
    });
    console.log(`Agent Vault desktop UI: ${started.url}`);
    process.once("SIGINT", () => {
      void started.close().finally(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void started.close().finally(() => process.exit(0));
    });
    await new Promise(() => undefined);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

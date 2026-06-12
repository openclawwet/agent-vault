export { initConfig, loadConfig, type MacSyncConfig } from "./config.js";
export { pullCommand, pushCommand, scanCommand, statusCommand, watchCommand } from "./syncCommands.js";
export { addShare, loadShareConfig, removeShare, type ShareRecord } from "./shareConfig.js";
export { startDesktopUi } from "./uiServer.js";

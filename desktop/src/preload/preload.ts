import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ChatmanyBridge, GateView } from "../shared/bridge";

/**
 * The window's only door to the main process: `window.chatmany`. A sandboxed
 * preload can load no file of its own, so the channel names are written out
 * here (shared/bridge.ts CHANNELS has the same list; a unit test compares
 * them). Nothing here holds or returns the publik key.
 */
const bridge: ChatmanyBridge = {
  gate: {
    get: () => ipcRenderer.invoke("gate:get"),
    signIn: () => ipcRenderer.invoke("gate:sign-in"),
    retry: () => ipcRenderer.invoke("gate:retry"),
    onChange(listener) {
      const wrapped = (_event: IpcRendererEvent, view: GateView) => listener(view);
      ipcRenderer.on("gate:changed", wrapped);
      return () => {
        ipcRenderer.removeListener("gate:changed", wrapped);
      };
    },
  },
  workspace: {
    status: (connectId) => ipcRenderer.invoke("workspace:status", connectId),
    connect: () => ipcRenderer.invoke("workspace:connect"),
    reopenConnect: () => ipcRenderer.invoke("workspace:reopen-connect"),
    disconnect: () => ipcRenderer.invoke("workspace:disconnect"),
    api: (path, init) => ipcRenderer.invoke("workspace:api", path, init ?? {}),
    exportCsv: (campaignId) => ipcRenderer.invoke("workspace:export-csv", campaignId),
  },
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  info: { version: "0.1.4", platform: process.platform },
};

contextBridge.exposeInMainWorld("chatmany", bridge);

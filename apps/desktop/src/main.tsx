import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";

if (!window.dinorip) {
  window.dinorip = {
    platform: "browser",
    openImages: async () => ({ canceled: true, images: [] }),
    savePng: async () => ({ canceled: true, paths: [] }),
    exportAllPng: async () => ({ canceled: true, paths: [] }),
    saveProject: async () => ({ canceled: true, paths: [] }),
    openProject: async () => ({ canceled: true }),
    onMenuCommand: () => () => {},
    toggleFullscreen: async () => false,
    getUpdateState: async () => ({
      enabled: false,
      status: "disabled",
      currentVersion: "0.0.0",
      availableVersion: null,
      downloadedVersion: null,
      downloadPercent: null,
      checkedAt: null,
      message: "Automatic updates are only available in the desktop app.",
      errorContext: null,
      canRetry: false
    }),
    checkForUpdate: async () => ({
      checked: false,
      state: await window.dinorip.getUpdateState()
    }),
    downloadUpdate: async () => ({
      accepted: false,
      completed: false,
      state: await window.dinorip.getUpdateState()
    }),
    installUpdate: async () => ({
      accepted: false,
      completed: false,
      state: await window.dinorip.getUpdateState()
    }),
    openUpdatePage: async () => ({
      opened: false,
      url: "https://github.com/maria-rcks/dinorip/releases/latest",
      state: await window.dinorip.getUpdateState()
    }),
    onUpdateState: () => () => {}
  };
}

if (import.meta.env.DEV) {
  void import("./renderer/benchmark").then(({ installBenchmark }) => installBenchmark());
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

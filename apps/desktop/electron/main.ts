import { app, BrowserWindow, nativeImage, shell } from "electron";
import path from "node:path";
import { registerIpc } from "./ipc";

// Set before the app is ready so the menu bar, About panel, and userData path
// all use the product name instead of Electron's default. (Packaged builds get
// this from build.productName; this covers dev.)
app.setName("DinoRip");

let mainWindow: BrowserWindow | null = null;

// The runtime/Dock icon uses the pre-rounded squircle: macOS does not
// auto-squircle a programmatically-set Dock icon (unlike a packaged app's
// bundle icon), so we ship the rounded shape ourselves. It's an extraResource
// when packaged and lives under build/ during development.
function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon-rounded.png")
    : path.join(app.getAppPath(), "build", "icon-rounded.png");
}

function createWindow(): void {
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#f4f4f2",
    show: false,
    title: "DinoRip",
    icon: appIconPath(),
    // Drop the native chrome and let the renderer's header act as the title bar.
    // On macOS keep the traffic lights, nudged to sit inside the 22px header.
    titleBarStyle: isMac ? "hidden" : "default",
    ...(isMac ? { trafficLightPosition: { x: 10, y: 4 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Block in-app navigation and open any external links in the user's browser.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:")) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  // In dev the macOS dock shows the generic Electron icon; packaged builds use
  // the bundle icon instead. Set it explicitly so dev matches the brand.
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    const icon = nativeImage.createFromPath(appIconPath());
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }

  // Register IPC once for the app lifetime; handlers resolve the current window
  // lazily, so re-creating the window on macOS does not double-register.
  registerIpc(() => mainWindow);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error("Failed to initialize app:", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

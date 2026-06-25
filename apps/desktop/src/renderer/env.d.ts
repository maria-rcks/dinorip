import type { DinoripApi } from "@dinorip/ipc-contracts";

declare global {
  interface Window {
    dinorip: DinoripApi;
  }
}

export {};

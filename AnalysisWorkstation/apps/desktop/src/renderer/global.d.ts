import type { WorkstationApi } from "../shared/api";

declare global {
  interface Window {
    workstation: WorkstationApi;
  }
}

export {};

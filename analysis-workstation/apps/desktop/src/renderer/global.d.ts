import type { WorkstationApi } from "../shared/api";

declare global {
  interface Window {
    wafc: WorkstationApi;
  }
}

export {};

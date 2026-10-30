/// <reference types="vite/client" />

import type { PaperliteApi } from '../../preload/index'

declare global {
  interface Window {
    paperlite: PaperliteApi
  }
}

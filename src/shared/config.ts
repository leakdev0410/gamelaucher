/**
 * Embedded build configuration.
 *
 * These values previously came from `MAIN_VITE_*` / `RENDERER_VITE_*` environment
 * variables (a `.env` file baked in at build time). They are hardcoded here so the
 * build is fully self-contained and does not depend on a `.env` file being present.
 *
 * To point the app at different servers, edit the values below and rebuild.
 */
export const appConfig = {
  apiUrl: "https://hydra-api-us-east-1.losbroxas.org",
  authUrl: "https://auth.hydralauncher.gg",
  wsUrl: "wss://ws.hydralauncher.gg",
  nimbusApiUrl: "https://nimbus-us-east-1.hydralauncher.gg",
  externalResourcesUrl: "https://assets.hydralauncher.gg",
  launcherSubdomain: "",
  sentryDsn: "",
  torboxReferralCode: "",
  realDebridReferralId: "",
} as const;

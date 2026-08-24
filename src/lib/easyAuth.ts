// Header injected by App Service Easy Auth. Client-supplied copies are
// stripped by the platform, so its presence means an authenticated request.
export const PRINCIPAL_HEADER = "x-ms-client-principal-name";

// Set EMMA_REQUIRE_AUTH=true once Easy Auth is configured on the App
// Service. Until then the app keeps its cookie-based acting-as behaviour.
export function authEnforced(): boolean {
  return process.env.EMMA_REQUIRE_AUTH === "true";
}

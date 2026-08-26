// Header injected by App Service Easy Auth. Client-supplied copies are
// stripped by the platform, so its presence means an authenticated request.
export const PRINCIPAL_HEADER = "x-ms-client-principal-name";

// The name header is the UPN alone. This one is base64 JSON carrying every
// claim, including the mail address, which at Imperial differs from the UPN.
export const PRINCIPAL_CLAIMS_HEADER = "x-ms-client-principal";

// Set EMMA_REQUIRE_AUTH=true once Easy Auth is configured on the App
// Service. Until then the app keeps its cookie-based acting-as behaviour.
export function authEnforced(): boolean {
  return process.env.EMMA_REQUIRE_AUTH === "true";
}

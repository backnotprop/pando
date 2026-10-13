// The MCP endpoint's sign-in (worker/src/mcp/oauth.ts): Pando is the OAuth authorization server for its
// own /mcp. These are OAuth's documents and answers (RFC 9728, RFC 8414, RFC 7591, RFC 6749), not the
// /v1 error shape. The MCP messages themselves follow the MCP specification's schema (2026-07-28, and
// 2025-06-18 for 2025-era hosts) and are not repeated here.
import * as Schema from "effect/Schema";

/** GET /.well-known/oauth-protected-resource[/mcp] (RFC 9728): what /mcp is and who issues its tokens. */
export const ProtectedResourceMetadata = Schema.Struct({
  /** <origin>/mcp: the resource a token is for. */
  resource: Schema.String,
  /** Pando's own origin, the only issuer. */
  authorization_servers: Schema.Array(Schema.String),
  bearer_methods_supported: Schema.Array(Schema.Literal("header")),
  /** One scope, `mcp`: everything the person can do, through /mcp. */
  scopes_supported: Schema.Array(Schema.String),
  resource_name: Schema.String,
});

export interface ProtectedResourceMetadata extends Schema.Schema.Type<typeof ProtectedResourceMetadata> {}

/** GET /.well-known/oauth-authorization-server[/mcp] (RFC 8414). */
export const AuthorizationServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  /** Dynamic registration (RFC 7591), deprecated in MCP 2026-07-28 and kept for 2025-era hosts. */
  registration_endpoint: Schema.String,
  revocation_endpoint: Schema.String,
  response_types_supported: Schema.Array(Schema.Literal("code")),
  /** No refresh_token: the credential lasts until revoked. */
  grant_types_supported: Schema.Array(Schema.Literal("authorization_code")),
  code_challenge_methods_supported: Schema.Array(Schema.Literal("S256")),
  token_endpoint_auth_methods_supported: Schema.Array(Schema.Literal("none")),
  revocation_endpoint_auth_methods_supported: Schema.Array(Schema.Literal("none")),
  scopes_supported: Schema.Array(Schema.String),
  /** Client ID Metadata Documents: an https client_id naming its own JSON. */
  client_id_metadata_document_supported: Schema.Boolean,
  /** Redirects back to the app carry `iss` (RFC 9207). */
  authorization_response_iss_parameter_supported: Schema.Boolean,
});

export interface AuthorizationServerMetadata extends Schema.Schema.Type<typeof AuthorizationServerMetadata> {}

/** POST /oauth/register (201): what Pando keeps and honours for a public client. Absent fields are left out, never null. */
export const OAuthClientRegistration = Schema.Struct({
  /** `pmc_` and 40 hex characters. */
  client_id: Schema.String,
  client_id_issued_at: Schema.Int,
  /** The name the app gave (control and format characters taken out, at most 120), or "Unnamed app". */
  client_name: Schema.String,
  redirect_uris: Schema.Array(Schema.String),
  grant_types: Schema.Array(Schema.Literal("authorization_code")),
  response_types: Schema.Array(Schema.Literal("code")),
  token_endpoint_auth_method: Schema.Literal("none"),
  scope: Schema.String,
});

export interface OAuthClientRegistration extends Schema.Schema.Type<typeof OAuthClientRegistration> {}

/** POST /oauth/token (200): a Pando credential of kind `mcp`, named after the app. */
export const OAuthToken = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  /** Ten years in seconds: the credential lasts until revoked (hosts read a missing value as one hour). */
  expires_in: Schema.Int,
  scope: Schema.String,
});

export interface OAuthToken extends Schema.Schema.Type<typeof OAuthToken> {}

/** Every refusal of the OAuth doors, and /mcp's 401 body: an OAuth error code and fixed words. */
export const OAuthError = Schema.Struct({ error: Schema.String, error_description: Schema.String });

export interface OAuthError extends Schema.Schema.Type<typeof OAuthError> {}

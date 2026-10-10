/**
 * Settings-side wire shapes.
 *
 * None of these live in the contract leaf (`src/server/protocol.ts` covers events and
 * session records only), so each field below is transcribed from the route that reads
 * or validates it, with the line cited. Values in comments are what this build
 * actually observed on a live sidecar — not what the handler could theoretically
 * return.
 */

/** GET/PUT /config/approval — src/server/config-routes.ts:945-953. */
export interface ApprovalConfig {
  /**
   * Observed: 'auto-safe'. Same vocabulary as the session-level `ApprovalMode` in the
   * contract (protocol.ts:71); the per-session override lives on the record, so this
   * global is only the default a new session inherits.
   */
  approval: string
  /** PUT accepts this alongside approval (config-routes.ts:946); GET echoes it. */
  unsandboxed?: boolean
}

/** GET/PUT /config/default-model. PUT requires 'provider:modelId' — plain ids 400. */
export interface DefaultModelConfig {
  /** Observed: 'deepseek:deepseek-flash', or null when unset. */
  defaultModel: string | null
  defaultEffort: string | null
}

/** GET /config/default-domain. 星域 selection — plan §4.3 maps these to `custom`. */
export interface DomainConfig {
  /** Observed: 'qiming'. */
  defaultDomain: string
  domainKeywordRouting: boolean
  domains: Array<{ id: string; name: string; motto: string }>
}

/** GET/PUT /config/checkpoint — the shadow-checkpoint cadence the M2 panel reads. */
export interface CheckpointConfig {
  /** Observed: 0 (disabled). */
  checkpointEveryTurns: number
}

/**
 * GET /config/providers. `keyStatus.ref` is already masked by the server (observed
 * '***11c8'), so the client never handles plaintext — keep it that way: no settings
 * view should try to read a key back.
 */
export interface ProviderConfigEntry {
  name: string
  label: string
  baseUrl: string
  protocol: string
  isDefault: boolean
  isPreset: boolean
  keyless?: boolean
  effortSupported?: boolean
  allowProFallback?: boolean
  presetModelIds?: string[]
  keyStatus: { source: 'inline' | 'env' | 'oauth' | 'none' | string; ref: string }
  models: Array<{ id: string; contextWindow?: number; maxTokens?: number; description?: string }>
  keys: Array<{
    id: string
    label: string
    keyStatus: { source: string; ref: string }
    models: Array<{ id: string; contextWindow?: number; maxTokens?: number }>
  }>
}

export interface ProviderConfigList {
  providers: ProviderConfigEntry[]
}

/**
 * PUT /config/providers/:name/keys/:keyId/key — src/server/config-routes-keys.ts:129-139.
 * `apiKey` and `apiKeyEnv` are mutually exclusive (400 when both are sent), which this
 * type encodes instead of letting the UI discover it at runtime.
 */
export type SetKeyRequest =
  | { apiKey: string; apiKeyEnv?: undefined; label?: string }
  | { apiKey?: undefined; apiKeyEnv: string; label?: string }
  | { apiKey?: undefined; apiKeyEnv?: undefined; label: string }

/** POST /config/providers/custom — baseUrl is required, providerName must be new. */
export interface CreateCustomProviderRequest {
  providerName: string
  baseUrl: string
  protocol?: string
  apiKey?: string
  apiKeyEnv?: string
  makeDefault?: boolean
  model?: { id: string; contextWindow?: number; maxTokens?: number }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import { API_PATHS } from './paths';
import { GUI_ERRORS } from '../i18n/gui-errors';
import { getCsrfToken } from '../lib/csrf';
import type {
  HealthStatus,
  SystemInfo,
  DivisionsResponse,
  DivisionResponse,
  AgentsResponse,
  AgentResponse,
  AgentLifecycleStatus,
  StarterAgentsResponse,
  StarterAgentResponse,
  StarterDivisionsResponse,
  TasksResponse,
  TaskResponse,
  AuditResponse,
  CostsResponse,
  GovernanceStatus,
  GovernanceHistory,
  LoggingStatus,
  ProviderCatalogResponse,
  ProviderConfigResponse,
  ProviderTestResult,
  ChatHistoryResponse,
  WorkspaceConfigResponse,
  FirstRunCompleteResponse,
  ScanResult,
  BouncerConfigResponse,
  BackupResult,
  ActivityStreamResponse,
} from './types';


const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Validate and encode a user-supplied path segment.
 * Prevents path traversal (e.g. "../../admin") by rejecting any value that
 * is not purely alphanumeric, hyphen, or underscore.
 */
function validatePathParam(value: string, name: string): string {
  const trimmed = value.trim();
  if (!SAFE_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid ${name}: must be 1-128 alphanumeric characters, hyphens, or underscores`,
    );
  }
  return encodeURIComponent(trimmed);
}

/** Maximum length for a query parameter value (guards against oversized inputs). */
const MAX_QUERY_PARAM_LENGTH = 256;

/**
 * Sanitize a user-supplied query parameter value.
 * - Strips ASCII control characters (0x00–0x1F, 0x7F) to prevent header injection
 * - Truncates to MAX_QUERY_PARAM_LENGTH to prevent oversized queries
 * - URL-encodes the result for safe inclusion in query strings
 */
function sanitizeQueryParam(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, '');
  return encodeURIComponent(cleaned.slice(0, MAX_QUERY_PARAM_LENGTH));
}


/** Categorises the cause of an API failure. */
export enum ApiErrorType {
  /** DNS failure, refused connection, or other network-level error. */
  NETWORK = 'network',
  /** 401 / 403 authentication or authorisation failure. */
  AUTH    = 'auth',
  /** 5xx server-side error. */
  SERVER  = 'server',
  /** 4xx client error (bad request, not found, etc.). */
  CLIENT  = 'client',
  /** JSON parse failure on a successful response body. */
  PARSE   = 'parse',
  /** Request was aborted (timeout or component unmount). */
  ABORTED = 'aborted',
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly type: ApiErrorType,
    public readonly status: number = 0,
    public readonly retryable: boolean = false,
    /** GUI error catalog code — used by formatGuiError() for i18n-ready display. */
    public readonly guiCode?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized(): boolean { return this.status === 401; }
  get isNotFound(): boolean      { return this.status === 404; }
  get isServerError(): boolean   { return this.status >= 500; }
}

/**
 * Classify an HTTP error response into a typed ApiError.
 * Returns a user-friendly message (see gui-errors.ts) instead of raw status codes.
 */
function classifyHttpError(status: number, _body: string): ApiError {
  if (status === 401 || status === 403) {
    return new ApiError(
      `${GUI_ERRORS['GUI-AUTH-002'].message} ${GUI_ERRORS['GUI-AUTH-002'].suggestion}`,
      ApiErrorType.AUTH, status, false, 'GUI-AUTH-002',
    );
  }
  if (status >= 500) {
    return new ApiError(
      `${GUI_ERRORS['GUI-CONN-002'].message} ${GUI_ERRORS['GUI-CONN-002'].suggestion}`,
      ApiErrorType.SERVER, status, true, 'GUI-CONN-002',
    );
  }
  return new ApiError(
    `${GUI_ERRORS['GUI-CONN-003'].message} ${GUI_ERRORS['GUI-CONN-003'].suggestion}`,
    ApiErrorType.CLIENT, status, false, 'GUI-CONN-003',
  );
}

/**
 * Classify a fetch() throw into a typed ApiError.
 * Distinguishes abort, network, and unknown errors.
 */
function classifyFetchError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new ApiError(
      `${GUI_ERRORS['GUI-CONN-004'].message} ${GUI_ERRORS['GUI-CONN-004'].suggestion}`,
      ApiErrorType.ABORTED, 0, false, 'GUI-CONN-004',
    );
  }
  if (err instanceof TypeError) {
    // fetch() throws TypeError on network-level failures (DNS, refused connection)
    return new ApiError(
      `${GUI_ERRORS['GUI-CONN-001'].message} ${GUI_ERRORS['GUI-CONN-001'].suggestion}`,
      ApiErrorType.NETWORK, 0, true, 'GUI-CONN-001',
    );
  }
  return new ApiError(
    `${GUI_ERRORS['GUI-CONN-001'].message} ${GUI_ERRORS['GUI-CONN-001'].suggestion}`,
    ApiErrorType.NETWORK, 0, true, 'GUI-CONN-001',
  );
}


/** Per-endpoint timeouts. Health has a short window; long-running operations get more time. */
const TIMEOUT_MS = {
  health:  5_000,   // health check must respond quickly
  default: 10_000,  // standard API calls
  long:    60_000,  // backup, wipe, and other long-running operations
} as const;

export class SidjuaApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly onAuthFailure?: () => void,
  ) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = {
      'Authorization':    `Bearer ${this.apiKey}`,
      'Accept':           'application/json',
      'Content-Type':     'application/json',
      // Custom marker for CSRF defense-in-depth — browsers can't set this cross-origin
      // without triggering a CORS preflight; browser extensions cannot forge it.
      'X-SIDJUA-Request': '1',
    };
    // Include CSRF token when a session is active (double-submit pattern, P434b).
    const csrf = getCsrfToken();
    if (csrf !== null) h['X-CSRF-Token'] = csrf;
    return h;
  }

  async get<T>(path: string, timeoutMs: number = TIMEOUT_MS.default, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.headers(),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err);
    }
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      throw classifyHttpError(res.status, await res.text());
    }
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body?: unknown, timeoutMs: number = TIMEOUT_MS.default, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err);
    }
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      throw classifyHttpError(res.status, await res.text());
    }
    return res.json() as Promise<T>;
  }

  async put<T>(path: string, body?: unknown, timeoutMs: number = TIMEOUT_MS.default, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'PUT',
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err);
    }
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      throw classifyHttpError(res.status, await res.text());
    }
    return res.json() as Promise<T>;
  }

  async patch<T>(path: string, body?: unknown, timeoutMs: number = TIMEOUT_MS.default, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'PATCH',
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err);
    }
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      throw classifyHttpError(res.status, await res.text());
    }
    return res.json() as Promise<T>;
  }

  async delete<T>(path: string, timeoutMs: number = TIMEOUT_MS.default, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'DELETE',
        headers: this.headers(),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err);
    }
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      throw classifyHttpError(res.status, await res.text());
    }
    return res.json() as Promise<T>;
  }

  // ---- Typed endpoint methods (FIX M4 — all paths from API_PATHS) ----------

  async health(): Promise<HealthStatus> {
    // Health is public — no API key required, but we send it anyway (harmless)
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${API_PATHS.health()}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS.health),
      });
    } catch (err) {
      throw classifyFetchError(err);
    }
    if (!res.ok) throw classifyHttpError(res.status, '');
    return res.json() as Promise<HealthStatus>;
  }

  info():             Promise<SystemInfo>        { return this.get(API_PATHS.info()); }

  listDivisions():    Promise<DivisionsResponse> { return this.get(API_PATHS.divisions()); }
  getDivision(code: string): Promise<DivisionResponse> {
    return this.get(API_PATHS.division(validatePathParam(code, 'code')));
  }

  listAgents(params?: {
    division?: string;
    status?: AgentLifecycleStatus;
    tier?: 1 | 2 | 3;
  }): Promise<AgentsResponse> {
    const qs = new URLSearchParams();
    if (params?.division) qs.set('division', sanitizeQueryParam(params.division));
    if (params?.status)   qs.set('status',   sanitizeQueryParam(params.status));
    if (params?.tier)     qs.set('tier',     String(params.tier));
    const q = qs.toString();
    return this.get(`${API_PATHS.agents()}${q ? `?${q}` : ''}`);
  }

  getAgent(id: string):   Promise<AgentResponse> { return this.get(API_PATHS.agent(validatePathParam(id, 'id'))); }
  startAgent(id: string): Promise<AgentResponse> { return this.post(API_PATHS.agentStart(validatePathParam(id, 'id'))); }
  stopAgent(id: string):  Promise<AgentResponse> { return this.post(API_PATHS.agentStop(validatePathParam(id, 'id'))); }
  patchAgent(id: string, patch: { name?: string; description?: string; tier?: number; provider?: string; model?: string }): Promise<AgentResponse> {
    return this.patch(API_PATHS.agentPatch(validatePathParam(id, 'id')), patch);
  }

  listStarterAgents():                    Promise<StarterAgentsResponse> { return this.get(API_PATHS.starterAgents()); }
  getStarterAgent(id: string):            Promise<StarterAgentResponse>  { return this.get(API_PATHS.starterAgent(validatePathParam(id, 'id'))); }
  listStarterDivisions():                 Promise<StarterDivisionsResponse> { return this.get(API_PATHS.starterDivisions()); }

  listTasks(params?: {
    status?: string;
    division?: string;
    agent?: string;
    limit?: number;
    offset?: number;
  }): Promise<TasksResponse> {
    const qs = new URLSearchParams();
    if (params?.status)   qs.set('status',   sanitizeQueryParam(params.status));
    if (params?.division) qs.set('division', sanitizeQueryParam(params.division));
    if (params?.agent)    qs.set('agent',    sanitizeQueryParam(params.agent));
    if (params?.limit)    qs.set('limit',    String(Math.max(0, Math.floor(params.limit))));
    if (params?.offset)   qs.set('offset',   String(Math.max(0, Math.floor(params.offset))));
    const q = qs.toString();
    return this.get(`${API_PATHS.tasks()}${q ? `?${q}` : ''}`);
  }

  getTask(id: string): Promise<TaskResponse> {
    return this.get(API_PATHS.task(validatePathParam(id, 'id')));
  }

  listAudit(params?: {
    division?: string;
    agent?: string;
    event?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<AuditResponse> {
    const qs = new URLSearchParams();
    if (params?.division) qs.set('division', sanitizeQueryParam(params.division));
    if (params?.agent)    qs.set('agent',    sanitizeQueryParam(params.agent));
    if (params?.event)    qs.set('event',    sanitizeQueryParam(params.event));
    if (params?.from)     qs.set('from',     sanitizeQueryParam(params.from));
    if (params?.to)       qs.set('to',       sanitizeQueryParam(params.to));
    if (params?.limit)    qs.set('limit',    String(Math.max(0, Math.floor(params.limit))));
    if (params?.offset)   qs.set('offset',   String(Math.max(0, Math.floor(params.offset))));
    const q = qs.toString();
    return this.get(`${API_PATHS.audit()}${q ? `?${q}` : ''}`);
  }

  governanceStatus():  Promise<GovernanceStatus>  { return this.get(API_PATHS.governanceStatus()); }
  governanceHistory(): Promise<GovernanceHistory> { return this.get(API_PATHS.governanceHistory()); }
  loggingStatus():     Promise<LoggingStatus>     { return this.get(API_PATHS.loggingStatus()); }
  setErrorLogging(enabled: boolean): Promise<{ errorLogging: boolean }> {
    return this.patch(API_PATHS.loggingPatch(), { errorLogging: enabled });
  }

  getProviderCatalog(): Promise<ProviderCatalogResponse> { return this.get(API_PATHS.providerCatalog()); }
  getProviderConfig():  Promise<ProviderConfigResponse>  { return this.get(API_PATHS.providerConfig()); }

  saveProviderConfig(body: {
    mode: 'simple' | 'advanced';
    default_provider: { provider_id: string; api_key: string; api_base?: string; model?: string; custom_name?: string } | null;
    agent_overrides?: Record<string, { provider_id: string; api_key: string; api_base?: string; model?: string }>;
  }): Promise<ProviderConfigResponse> { return this.put(API_PATHS.providerConfig(), body); }

  deleteProviderConfig(): Promise<{ configured: false; message: string }> { return this.delete(API_PATHS.providerConfig()); }

  testProvider(body: {
    provider_id?: string;
    api_key:      string;
    api_base?:    string;
    model?:       string;
  }): Promise<ProviderTestResult> { return this.post(API_PATHS.providerTest(), body); }

  /** Return a Headers object for making manual fetch calls (e.g. streaming). */
  authHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  getChatHistory(agentId: string, params?: { conversation_id?: string; limit?: number }): Promise<ChatHistoryResponse> {
    const qs = new URLSearchParams();
    if (params?.conversation_id) qs.set('conversation_id', params.conversation_id);
    if (params?.limit)           qs.set('limit', String(params.limit));
    const q = qs.toString();
    return this.get(`${API_PATHS.chatHistory(validatePathParam(agentId, 'agentId'))}${q ? `?${q}` : ''}`);
  }

  clearChatHistory(agentId: string): Promise<{ cleared: boolean; agent_id: string }> {
    return this.delete(`${API_PATHS.chatHistory(validatePathParam(agentId, 'agentId'))}`);
  }

  listCosts(params?: {
    division?: string;
    agent?: string;
    period?: '1h' | '24h' | '7d' | '30d';
    from?: string;
    to?: string;
  }): Promise<CostsResponse> {
    const qs = new URLSearchParams();
    if (params?.division) qs.set('division', sanitizeQueryParam(params.division));
    if (params?.agent)    qs.set('agent',    sanitizeQueryParam(params.agent));
    if (params?.period)   qs.set('period',   sanitizeQueryParam(params.period));
    if (params?.from)     qs.set('from',     sanitizeQueryParam(params.from));
    if (params?.to)       qs.set('to',       sanitizeQueryParam(params.to));
    const q = qs.toString();
    return this.get(`${API_PATHS.costs()}${q ? `?${q}` : ''}`);
  }

  // ---- Workspace config (P188) ---------------------------------------------

  getWorkspaceConfig(): Promise<WorkspaceConfigResponse> {
    return this.get(API_PATHS.workspaceConfig());
  }

  completeFirstRun(): Promise<FirstRunCompleteResponse> {
    return this.post(API_PATHS.firstRunComplete());
  }

  // ---- Apply configuration (#4, #10) --------------------------------------

  triggerApply(): Promise<{ success: boolean; steps: number; duration: number; summary: Array<{ step: string; success: boolean; summary: string }> }> {
    return this.post(API_PATHS.apply());
  }

  // ---- Bouncer (sensitive data filter) ------------------------------------

  getBouncerConfig(): Promise<BouncerConfigResponse> {
    return this.get(API_PATHS.bouncerConfig());
  }

  setBouncerConfig(body: Partial<BouncerConfigResponse>): Promise<BouncerConfigResponse> {
    return this.put(API_PATHS.bouncerConfig(), body);
  }

  scanMessage(message: string): Promise<ScanResult> {
    return this.post(API_PATHS.chatScan(), { message });
  }

  createBackup(): Promise<BackupResult> {
    return this.post(API_PATHS.backup(), undefined, TIMEOUT_MS.long);
  }

  listErrorEvents(limit = 20): Promise<ActivityStreamResponse> {
    return this.get(`${API_PATHS.activityStream()}?severity=error&limit=${limit}`);
  }

  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return this.post(API_PATHS.authPasswordChange(), { currentPassword, newPassword });
  }
}

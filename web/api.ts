export class ApiError extends Error {
  status: number;
  requestId: string | undefined;
  code: string | undefined;
  constructor(message: string, status = 0, requestId?: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.requestId = requestId;
    this.code = code;
  }
}

export class ApiClient {
  csrfToken = "";
  private transport: typeof fetch;
  readonly basePath: string;
  constructor(
    transport: typeof fetch = window.fetch.bind(window),
    basePath = "/api/v1",
  ) {
    this.transport = transport;
    this.basePath = basePath;
  }
  async request<T>(
    path: string,
    options: RequestInit = {},
    responseType: "json" | "blob" = "json",
  ): Promise<T> {
    const headers = new Headers(options.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    let response: Response;
    try {
      response = await this.transport(`${this.basePath}${path}`, {
        ...options,
        credentials: "same-origin",
        mode: "same-origin",
        headers,
      });
    } catch {
      throw new ApiError("Check your connection and try again.");
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string; requestId?: string; code?: string };
      } | null;
      throw new ApiError(
        body?.error?.message ||
          "The request could not be completed. Please try again.",
        response.status,
        body?.error?.requestId,
        body?.error?.code,
      );
    }
    if (response.status === 204) return undefined as T;
    if (responseType === "blob") return response.blob() as Promise<T>;
    return response.json() as Promise<T>;
  }
  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }
  post<T>(path: string, body: unknown, authenticated = true): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { "X-CSRF-Token": this.csrfToken } : {}),
      },
      body: JSON.stringify(body),
    });
  }
}

export function takeLoginToken(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">,
): string | null {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (!fragment.has("login")) return null;
  const token = fragment.get("login") || "";
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return token;
}

export function watchLoginTokens(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">,
  events: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  onToken: (token: string) => void,
): () => void {
  const read = () => {
    const token = takeLoginToken(location, history);
    if (token !== null) onToken(token);
  };
  read();
  events.addEventListener("hashchange", read);
  return () => events.removeEventListener("hashchange", read);
}

export interface Plan {
  id: string;
  name: string;
  site_allowance: number;
}
export type Framework =
  | "wordpress"
  | "joomla"
  | "electron"
  | "tauri"
  | "sparkle"
  | "jetbrains"
  | "generic";
export interface FrameworkProduct {
  framework?: Framework;
  frameworkConfig?: {
    activationKind?: "site" | "device";
    [key: string]: unknown;
  };
}
export interface ReleaseAsset {
  id: string;
  target: string;
  filename: string;
  size: number;
  checksum: string;
  sha512: string;
  signature: string | null;
  min_system_version: string | null;
}
export interface Product extends FrameworkProduct {
  id: string;
  name: string;
  slug: string;
  plans: Plan[];
}
export interface Installation {
  id: string;
  installation_id: string;
  site_url: string;
  label?: string | null;
  active: boolean;
  exempt: boolean;
}
export interface Release {
  assets?: ReleaseAsset[];
  id: string;
  version: string;
  changelog: string;
  checksum: string;
  min_wp: string | null;
  min_php: string | null;
  min_free: string | null;
}
export interface License extends FrameworkProduct {
  provenance?: "paid" | "complimentary";
  expires_at?: number | null;
  id: string;
  product_id: string;
  product_name: string;
  plan_name: string;
  site_allowance: number;
  paid_through: number | null;
  billing_status: string;
  revoked: boolean;
  suspended: boolean;
  entitled: boolean;
  installations: Installation[];
  releases: Release[];
}
export interface Account {
  billingAvailable?: boolean;
  customer: { id: string; email: string };
  csrfToken: string;
  licenses: License[];
}
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError)
    return `${error.message}${error.requestId ? ` Reference: ${error.requestId}` : ""}`;
  return "Something went wrong. Please try again.";
}

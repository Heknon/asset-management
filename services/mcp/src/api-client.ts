/**
 * The other services' HTTP APIs, called with the person's own token: the MCP
 * server can do exactly what that person can do in the app, nothing more.
 */
export interface ServiceUrls {
  identity: string;
  registry: string;
  scheduler: string;
}

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ApiClient {
  constructor(
    private readonly urls: ServiceUrls,
    private readonly token: string,
    private readonly fetcher: typeof fetch,
  ) {}

  get<T>(service: keyof ServiceUrls, path: string, query: Record<string, unknown> = {}): Promise<T> {
    const qs = new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]): [string, string] => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]),
    ).toString();
    return this.call<T>('GET', service, qs ? `${path}?${qs}` : path);
  }

  post<T>(service: keyof ServiceUrls, path: string, body: unknown): Promise<T> {
    return this.call<T>('POST', service, path, body);
  }

  private async call<T>(method: string, service: keyof ServiceUrls, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(`${this.urls[service].replace(/\/$/, '')}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch((err: unknown) => {
      throw new ApiCallError(503, `The ${service} service is not reachable (${(err as Error).message})`);
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `${service} answered ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; details?: { issues?: Array<{ path: unknown[]; message: string }> } } };
        message = parsed.error?.message ?? message;
        const issues = parsed.error?.details?.issues;
        if (issues?.length) message += `: ${issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
      } catch {
        /* not JSON */
      }
      throw new ApiCallError(res.status, message);
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}

import { getConfig } from '../config/index.js';

export interface FetchOptions extends BunFetchRequestInit {
  timeout?: number;
  /** External abort signal (e.g., from scanner). Combined with timeout. */
  externalSignal?: AbortSignal;
}

export async function retryFetch(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const config = getConfig();
  const retries = config.retry;
  const timeout = options.timeout ?? config.dlsiteTimeout;
  let lastError: Error | null = null;

  for (let i = 0; i <= retries; i++) {
    try {
      // Check external signal before each attempt
      if (options.externalSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      // Combine external signal with timeout signal
      const onExternalAbort = (): void => controller.abort();
      if (options.externalSignal) {
        if (options.externalSignal.aborted) {
          controller.abort();
        } else {
          options.externalSignal.addEventListener('abort', onExternalAbort, {
            once: true,
          });
        }
      }

      const fetchOptions: BunFetchRequestInit = {
        ...options,
        signal: controller.signal,
      };

      // Add proxy if configured
      if (config.httpProxyHost && config.httpProxyPort > 0) {
        fetchOptions.proxy = `http://${config.httpProxyHost}:${config.httpProxyPort}`;
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timer);
      if (options.externalSignal) {
        options.externalSignal.removeEventListener('abort', onExternalAbort);
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } catch (err) {
      lastError = err as Error;

      // Don't retry if aborted
      if (lastError.name === 'AbortError') {
        throw lastError;
      }

      if (i < retries) {
        const delay = config.retryDelay * (i + 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

export async function fetchText(
  url: string,
  options?: FetchOptions,
): Promise<string> {
  const response = await retryFetch(url, options);
  return response.text();
}

export async function fetchJson<T = unknown>(
  url: string,
  options?: FetchOptions,
): Promise<T> {
  const response = await retryFetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...options?.headers,
    },
  });
  return response.json() as Promise<T>;
}

export async function fetchHtml(
  url: string,
  options?: FetchOptions,
): Promise<string> {
  const response = await retryFetch(url, {
    ...options,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...options?.headers,
    },
  });
  return response.text();
}

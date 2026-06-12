import type {
  CurrentDeviceResult,
  ListFilesResult,
  ListSpacesResult,
  UploadFileResult,
  VaultFileRecord,
} from "@agent-vault/core";

export interface VaultSession {
  serverUrl: string;
  token: string;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export class VaultClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VaultClientError";
  }
}

function cleanServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, "");
}

async function parseResponseError(response: Response): Promise<VaultClientError> {
  const fallback = response.statusText || "Agent Vault request failed.";
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return new VaultClientError(
      response.status,
      body.error?.code ?? "request_failed",
      body.error?.message ?? fallback,
    );
  } catch {
    return new VaultClientError(response.status, "request_failed", fallback);
  }
}

function requestHeaders(token: string, contentType?: string): HeadersInit {
  const headers: HeadersInit = {
    authorization: `Bearer ${token}`,
  };
  if (contentType) {
    headers["content-type"] = contentType;
  }
  return headers;
}

function mimeForPath(path: string, fallback = "application/octet-stream"): string {
  const lowerPath = path.toLowerCase();
  if (/\.(png)$/.test(lowerPath)) return "image/png";
  if (/\.(jpe?g)$/.test(lowerPath)) return "image/jpeg";
  if (/\.(gif)$/.test(lowerPath)) return "image/gif";
  if (/\.(webp)$/.test(lowerPath)) return "image/webp";
  if (/\.(svg)$/.test(lowerPath)) return "image/svg+xml";
  if (/\.(pdf)$/.test(lowerPath)) return "application/pdf";
  if (/\.(txt|md|markdown|csv|json|xml|html|css|js|ts|tsx|jsx|log)$/.test(lowerPath)) return "text/plain";
  return fallback;
}

export class VaultClient {
  private readonly baseUrl: string;

  constructor(private readonly session: VaultSession) {
    this.baseUrl = cleanServerUrl(session.serverUrl);
  }

  async health(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw await parseResponseError(response);
    }
  }

  async me(): Promise<CurrentDeviceResult> {
    const response = await fetch(`${this.baseUrl}/me`, {
      headers: requestHeaders(this.session.token),
    });
    if (!response.ok) {
      throw await parseResponseError(response);
    }
    return (await response.json()) as CurrentDeviceResult;
  }

  async listSpaces(): Promise<ListSpacesResult> {
    const response = await fetch(`${this.baseUrl}/spaces`, {
      headers: requestHeaders(this.session.token),
    });
    if (!response.ok) {
      throw await parseResponseError(response);
    }
    return (await response.json()) as ListSpacesResult;
  }

  async listFiles(space: string): Promise<ListFilesResult> {
    const response = await fetch(`${this.baseUrl}/spaces/${encodeURIComponent(space)}/files`, {
      headers: requestHeaders(this.session.token),
    });
    if (!response.ok) {
      throw await parseResponseError(response);
    }
    return (await response.json()) as ListFilesResult;
  }

  async downloadFile(file: Pick<VaultFileRecord, "space" | "path">): Promise<Blob> {
    const response = await fetch(
      `${this.baseUrl}/spaces/${encodeURIComponent(file.space)}/file?path=${encodeURIComponent(file.path)}`,
      {
        headers: requestHeaders(this.session.token),
      },
    );
    if (!response.ok) {
      throw await parseResponseError(response);
    }
    const blob = await response.blob();
    return blob.type ? blob : blob.slice(0, blob.size, mimeForPath(file.path));
  }

  uploadFile(
    space: string,
    targetPath: string,
    file: File,
    onProgress: (progress: UploadProgress) => void,
  ): Promise<UploadFileResult> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const url = `${this.baseUrl}/spaces/${encodeURIComponent(space)}/file?path=${encodeURIComponent(targetPath)}`;

      xhr.open("PUT", url);
      xhr.setRequestHeader("authorization", `Bearer ${this.session.token}`);
      xhr.setRequestHeader("idempotency-key", `${crypto.randomUUID()}:${targetPath}`);
      xhr.setRequestHeader("content-type", file.type || mimeForPath(file.name));

      xhr.upload.onprogress = (event) => {
        const total = event.lengthComputable ? event.total : file.size;
        const percent = total ? Math.round((event.loaded / total) * 100) : 0;
        onProgress({ loaded: event.loaded, total, percent });
      };

      xhr.onerror = () => reject(new VaultClientError(0, "network_error", "Could not reach Agent Vault."));
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          try {
            const parsed = JSON.parse(xhr.responseText) as { error?: { code?: string; message?: string } };
            reject(
              new VaultClientError(
                xhr.status,
                parsed.error?.code ?? "upload_failed",
                parsed.error?.message ?? "Upload failed.",
              ),
            );
          } catch {
            reject(new VaultClientError(xhr.status, "upload_failed", "Upload failed."));
          }
          return;
        }
        resolve(JSON.parse(xhr.responseText) as UploadFileResult);
      };

      xhr.send(file);
    });
  }
}

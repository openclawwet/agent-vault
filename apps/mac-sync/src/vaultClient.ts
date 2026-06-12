import type {
  ChangeEventRecord,
  CurrentDeviceResult,
  DeviceRecord,
  ListFilesResult,
  ListSpacesResult,
  SpaceAccessInfo,
  VaultFileRecord,
} from "@agent-vault/core";

export class VaultClient {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
  ) {}

  async listFiles(space: string): Promise<VaultFileRecord[]> {
    const response = await this.request(`/spaces/${encodeURIComponent(space)}/files`);
    const body = (await response.json()) as ListFilesResult;
    return body.files;
  }

  async listSpaces(): Promise<SpaceAccessInfo[]> {
    const response = await this.request("/spaces");
    const body = (await response.json()) as ListSpacesResult;
    return body.spaces;
  }

  async me(): Promise<CurrentDeviceResult> {
    const response = await this.request("/me");
    return (await response.json()) as CurrentDeviceResult;
  }

  async listDevices(): Promise<DeviceRecord[]> {
    const response = await this.request("/devices");
    const body = (await response.json()) as { devices: DeviceRecord[] };
    return body.devices;
  }

  async listChanges(space: string, since = 0): Promise<{ changes: ChangeEventRecord[]; cursor: number }> {
    const response = await this.request(`/spaces/${encodeURIComponent(space)}/changes?since=${encodeURIComponent(String(since))}`);
    return (await response.json()) as { changes: ChangeEventRecord[]; cursor: number };
  }

  async upload(space: string, filePath: string, body: Buffer, idempotencyKey: string): Promise<VaultFileRecord> {
    const response = await this.request(`/spaces/${encodeURIComponent(space)}/file?path=${encodeURIComponent(filePath)}`, {
      method: "PUT",
      headers: { "idempotency-key": idempotencyKey },
      body: new Uint8Array(body),
    });
    const json = (await response.json()) as { file: VaultFileRecord };
    return json.file;
  }

  async download(space: string, filePath: string): Promise<Buffer> {
    const response = await this.request(`/spaces/${encodeURIComponent(space)}/file?path=${encodeURIComponent(filePath)}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(space: string, filePath: string, idempotencyKey: string): Promise<void> {
    await this.request(`/spaces/${encodeURIComponent(space)}/file?path=${encodeURIComponent(filePath)}`, {
      method: "DELETE",
      headers: { "idempotency-key": idempotencyKey },
    });
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.serverUrl}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Vault request failed ${response.status}: ${text}`);
    }

    return response;
  }
}

export interface PrivateObjectDescriptor {
  readonly ref: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mimeType: string;
}

export interface PrivateObjectStore {
  put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void>;
  get(descriptor: PrivateObjectDescriptor): Promise<Uint8Array>;
  remove(ref: string): Promise<void>;
}

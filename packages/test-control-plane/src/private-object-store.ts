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

/** In-memory private store shared by local-only acceptance fixtures and tests. */
export class MemoryPrivateObjectStore implements PrivateObjectStore {
  readonly #objects = new Map<
    string,
    { readonly descriptor: PrivateObjectDescriptor; readonly bytes: Uint8Array }
  >();

  async put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void> {
    this.#objects.set(descriptor.ref, { descriptor, bytes: new Uint8Array(bytes) });
  }

  async get(descriptor: PrivateObjectDescriptor): Promise<Uint8Array> {
    const object = this.#objects.get(descriptor.ref);
    if (object === undefined) throw new Error(`test object ${descriptor.ref} is missing`);
    return new Uint8Array(object.bytes);
  }

  async remove(ref: string): Promise<void> {
    this.#objects.delete(ref);
  }
}

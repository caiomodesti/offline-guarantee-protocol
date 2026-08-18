import type { DurableStoragePort, StorageArea } from "@ogp/mobile-storage";

export function testGeneration(value: number): string {
  return value.toString(16).padStart(64, "0");
}

export class MemoryDurableStorage implements DurableStoragePort {
  readonly values = new Map<string, string>();
  operation = 0;
  failAt: number | null = null;

  private key(area: StorageArea, key: string): string {
    return `${area}:${key}`;
  }

  private boundary(): void {
    this.operation += 1;
    if (this.failAt === this.operation) throw new Error(`fault-${this.operation}`);
  }

  resetFault(failAt: number | null): void {
    this.operation = 0;
    this.failAt = failAt;
  }

  async get(area: StorageArea, key: string): Promise<string | null> {
    return this.values.get(this.key(area, key)) ?? null;
  }

  async set(area: StorageArea, key: string, value: string): Promise<void> {
    this.boundary();
    this.values.set(this.key(area, key), value);
  }

  async remove(area: StorageArea, key: string): Promise<void> {
    this.boundary();
    this.values.delete(this.key(area, key));
  }

  read(area: StorageArea, key: string): string | null {
    return this.values.get(this.key(area, key)) ?? null;
  }

  writeWithoutBoundary(area: StorageArea, key: string, value: string): void {
    this.values.set(this.key(area, key), value);
  }

  removeWithoutBoundary(area: StorageArea, key: string): void {
    this.values.delete(this.key(area, key));
  }
}

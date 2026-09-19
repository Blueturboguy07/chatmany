// A DurableObjectStorage-shaped Map, enough for UsageMeter and TenantRunner. Each instance is one
// tenant's object, which is what makes the isolation tests meaningful: two runners get two
// storages and one shared D1.

export class FakeStorage {
  readonly map = new Map<string, unknown>();
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }
}

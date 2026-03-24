import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export class ObjectStore {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? join(
      process.env.HOME ?? process.env.USERPROFILE ?? '.',
      '.0agent',
      'objects',
    );
  }

  /**
   * Store data and return an object reference (relative path within basePath).
   */
  async put(
    data: Buffer | string,
    opts?: { prefix?: string; extension?: string },
  ): Promise<string> {
    const prefix = opts?.prefix ?? '';
    const extension = opts?.extension ?? '';
    const filename = `${randomUUID()}${extension}`;
    const ref = prefix ? join(prefix, filename) : filename;
    const fullPath = join(this.basePath, ref);

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);

    return ref;
  }

  /**
   * Retrieve an object by its reference.
   */
  async get(ref: string): Promise<Buffer> {
    const fullPath = join(this.basePath, ref);
    return readFile(fullPath);
  }

  /**
   * Check whether an object exists.
   */
  async exists(ref: string): Promise<boolean> {
    const fullPath = join(this.basePath, ref);
    try {
      await access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete an object by its reference.
   */
  async delete(ref: string): Promise<void> {
    const fullPath = join(this.basePath, ref);
    await unlink(fullPath);
  }
}

/**
 * Bundled data files can be overridden without rebuilding the .exe: drop a file
 * with the same name in the settings folder (see appHome()) and its entries win.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHome } from './config';

export function readOverride<T>(name: string): T | null {
  const path = join(appHome(), name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (e) {
    throw new Error(`Could not read ${path}: ${e instanceof Error ? e.message : e}`);
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Cesium from 'cesium';

/**
 * Cesium API existence contract, checked against the REAL installed package.
 *
 * Unit tests stub viewers and deliberately route around Cesium calls (see
 * planets.test.mjs), so a reference to a member Cesium does not ship —
 * e.g. `JulianDate.toMilliseconds`, which threw on every Planets enable from
 * 2026-08-25 until 2026-10-04 — passes the whole suite and only fails live in
 * the browser. This walk closes that gap: every literal
 * `Cesium.<Namespace>.<member>` in src/ must resolve on the real namespace.
 *
 * Deliberately literal-only: dynamic access (`Cesium[name].x`) is not
 * statically checkable and stays out of scope.
 */

function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (entry.isFile() && /\.m?js$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const LITERAL_REF = /Cesium\.[A-Z][A-Za-z0-9]*\.[a-z][A-Za-z0-9_]*/g;

test('every literal Cesium.<Namespace>.<member> in src/ exists in the installed cesium', () => {
  const files = collectSourceFiles(new URL('.', import.meta.url).pathname.replace(/\/$/, ''));
  assert.ok(files.length > 50, `expected to walk a real tree, found ${files.length} files`);

  const missing = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(LITERAL_REF)) {
      const [, namespace, member] = match[0].split('.');
      if (!Cesium[namespace] || !(member in Cesium[namespace])) {
        missing.push(`${file}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    'references to Cesium members the installed package does not ship'
      + ' (stub-based tests cannot catch these):',
  );
});

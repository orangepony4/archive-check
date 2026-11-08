import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createManifest, verifyManifest } from '../src/archive.mjs';

const fs = createRequire(import.meta.url)('node:fs/promises');

for (const [operation, scan] of [
    ['create', root => createManifest(root)],
    ['scoped verify', (root, manifest) => verifyManifest(root, manifest, { under: 'nested' })],
]) {
    test(`${operation} detects a directory replacement before opening any files through it`, async t => {
        const tempRoot = await fs.realpath(tmpdir());
        const fixture = await fs.mkdtemp(join(tempRoot, 'archive-check-directory-change-'));
        t.after(async () => {
            assert.equal(dirname(await fs.realpath(fixture)), tempRoot);
            await fs.rm(fixture, { recursive: true, force: true });
        });

        const root = join(fixture, 'root');
        const nested = join(root, 'nested');
        const outside = join(fixture, 'outside');
        const outsideFile = join(outside, 'marker.txt');
        const replacement = join(fixture, 'replacement');
        await fs.mkdir(nested, { recursive: true });
        await fs.mkdir(outside);
        await fs.writeFile(join(nested, 'marker.txt'), 'inside archive');
        await fs.writeFile(outsideFile, 'outside folder');
        const manifest = await createManifest(root);
        try {
            await fs.symlink(outside, replacement, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
            if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
                t.skip(`Link creation is unavailable (${error.code})`);
                return;
            }
            throw error;
        }

        const { open, readdir } = fs;
        let replaced = false;
        let outsideOpens = 0;
        fs.readdir = async (path, options) => {
            if (path === nested && !replaced) {
                // The walker has statted this directory and is about to enumerate it.
                await fs.rename(nested, join(fixture, 'original'));
                await fs.rename(replacement, nested);
                replaced = true;
            }
            return readdir(path, options);
        };
        fs.open = (path, ...args) => {
            if (path === outsideFile || path === join(nested, 'marker.txt')) outsideOpens++;
            return open(path, ...args);
        };
        try {
            syncBuiltinESMExports();
            await assert.rejects(scan(root, manifest), /Archive entry changed during the scan: "nested"/);
            assert.equal(replaced, true);
            assert.equal(outsideOpens, 0);
        } finally {
            fs.open = open;
            fs.readdir = readdir;
            syncBuiltinESMExports();
        }
    });
}

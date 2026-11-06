import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../bin/archive-check.mjs', import.meta.url));

async function fixture(t) {
    const tempRoot = await realpath(tmpdir());
    const directory = await mkdtemp(join(tempRoot, 'archive-check-'));
    t.after(async () => {
        assert.equal(dirname(await realpath(directory)), tempRoot);
        await rm(directory, { recursive: true, force: true });
    });

    const archive = join(directory, 'my archive');
    await mkdir(archive);
    return {
        directory,
        archive,
        manifest: join(directory, 'manifest.json'),
        run(...args) {
            const result = spawnSync(process.execPath, [cliPath, ...args], {
                cwd: directory,
                encoding: 'utf8',
                timeout: 10_000,
                windowsHide: true,
            });
            assert.ifError(result.error);
            assert.equal(result.signal, null);
            return result;
        },
    };
}

function expectExit(result, code) {
    assert.equal(result.status, code, result.stderr || result.stdout);
}

function manifestEntry(path, contents) {
    const bytes = Buffer.from(contents);
    return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function symlinkOrSkip(t, target, link, type) {
    try {
        await symlink(target, link, type);
        return true;
    } catch (error) {
        if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
            t.skip(`Link creation is unavailable (${error.code})`);
            return false;
        }
        throw error;
    }
}

test('creates a portable sorted manifest and verifies it inside the archive', async t => {
    const { archive, run } = await fixture(t);
    const metadata = join(archive, 'metadata');
    const nested = join(archive, 'nested');
    await mkdir(metadata);
    await mkdir(nested);
    const manifest = join(metadata, 'checksums.json');
    const binary = Buffer.from([0, 255, 17, 128]);
    await writeFile(join(archive, 'zeta.txt'), 'last');
    await writeFile(join(nested, 'данные.bin'), binary);
    await writeFile(join(archive, 'alpha.txt'), '');
    await writeFile(join(archive, 'checksums.json'), 'same filename, different path');

    expectExit(run('create', 'my archive', '--manifest', join('my archive', 'metadata', 'checksums.json')), 0);
    assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), {
        version: 1,
        algorithm: 'sha256',
        files: [
            manifestEntry('alpha.txt', ''),
            manifestEntry('checksums.json', 'same filename, different path'),
            manifestEntry('nested/данные.bin', binary),
            manifestEntry('zeta.txt', 'last'),
        ],
    });

    const result = run('verify', archive, '--manifest', manifest, '--json');
    expectExit(result, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
        checked: 4, changed: [], missing: [], unexpected: [], unsupported: [],
    });
});

test('creates and verifies an empty manifest for an empty archive', async t => {
    const { archive, manifest, run } = await fixture(t);
    expectExit(run('create', archive, '--manifest', manifest), 0);
    assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), {
        version: 1, algorithm: 'sha256', files: [],
    });

    const result = run('verify', archive, '--manifest', manifest, '--json');
    expectExit(result, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
        checked: 0, changed: [], missing: [], unexpected: [], unsupported: [],
    });
});

test('compares two manifests without reading either archive', async t => {
    const { directory, run } = await fixture(t);
    const before = join(directory, 'before.json');
    const after = join(directory, 'after.json');
    const manifest = files => JSON.stringify({ version: 1, algorithm: 'sha256', files });
    await writeFile(before, manifest([
        manifestEntry('removed.txt', 'gone'),
        manifestEntry('stable.txt', 'same'),
        manifestEntry('changed.txt', 'before'),
    ]));
    await writeFile(after, manifest([
        manifestEntry('zeta.txt', 'added'),
        manifestEntry('changed.txt', 'second'),
        manifestEntry('alpha.txt', 'added'),
        manifestEntry('stable.txt', 'same'),
    ]));

    const different = run('compare', before, after, '--json');
    expectExit(different, 1);
    assert.deepEqual(JSON.parse(different.stdout), {
        unchanged: 1,
        added: ['alpha.txt', 'zeta.txt'],
        removed: ['removed.txt'],
        changed: ['changed.txt'],
    });
    const identical = run('compare', before, before, '--json');
    expectExit(identical, 0);
    assert.deepEqual(JSON.parse(identical.stdout), {
        unchanged: 3, added: [], removed: [], changed: [],
    });
    expectExit(run('compare', before, after, '--force'), 2);
    await writeFile(after, '{}');
    expectExit(run('compare', before, after, '--json'), 2);
});

test('reports changed, missing, and unexpected files together', async t => {
    const { archive, manifest, run } = await fixture(t);
    await writeFile(join(archive, 'same-size.txt'), 'abc');
    await writeFile(join(archive, 'different-size.txt'), 'old');
    await writeFile(join(archive, 'missing.txt'), 'gone soon');
    await writeFile(join(archive, 'unchanged.txt'), 'stays');
    expectExit(run('create', archive, '--manifest', manifest), 0);
    const originalManifest = await readFile(manifest, 'utf8');

    await writeFile(join(archive, 'same-size.txt'), 'xyz');
    await writeFile(join(archive, 'different-size.txt'), 'much longer');
    await rm(join(archive, 'missing.txt'));
    await writeFile(join(archive, 'extra.txt'), 'new');

    const result = run('verify', archive, '--manifest', manifest, '--json');
    expectExit(result, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
        checked: 1,
        changed: ['different-size.txt', 'same-size.txt'],
        missing: ['missing.txt'],
        unexpected: ['extra.txt'],
        unsupported: [],
    });
    assert.equal(await readFile(manifest, 'utf8'), originalManifest);
    assert.equal(await readFile(join(archive, 'same-size.txt'), 'utf8'), 'xyz');
});

test('rejects malformed or unsafe manifests', async t => {
    const { directory, archive, manifest, run } = await fixture(t);
    await writeFile(join(directory, 'outside.txt'), 'outside');
    const validEntry = manifestEntry('ok.txt', 'ok');
    const invalidEntries = [
        [manifestEntry('../outside.txt', 'outside')],
        [manifestEntry('C:/outside.txt', 'outside')],
        [manifestEntry('nested\\outside.txt', 'outside')],
        [manifestEntry('NUL.txt', '')],
        [manifestEntry('nested/trailing.', '')],
        [validEntry, validEntry],
        [validEntry, manifestEntry('OK.TXT', 'ok')],
        [validEntry, manifestEntry('ok.txt/nested', 'ok')],
        [{ ...validEntry, size: -1 }],
        [{ ...validEntry, sha256: 'invalid' }],
    ];
    for (const files of invalidEntries) {
        await writeFile(manifest, JSON.stringify({ version: 1, algorithm: 'sha256', files }));
        expectExit(run('verify', archive, '--manifest', manifest, '--json'), 2);
    }
    await writeFile(manifest, '{');
    expectExit(run('verify', archive, '--manifest', manifest, '--json'), 2);
    assert.equal(await readFile(join(directory, 'outside.txt'), 'utf8'), 'outside');
});

test('requires --force to replace a valid manifest and preserves unrelated output files', async t => {
    const { archive, manifest, run } = await fixture(t);
    const archivedFile = join(archive, 'file.txt');
    await writeFile(archivedFile, 'before');
    expectExit(run('create', archive, '--manifest', manifest), 0);
    const original = await readFile(manifest, 'utf8');

    await writeFile(archivedFile, 'after');
    expectExit(run('create', archive, '--manifest', manifest), 2);
    assert.equal(await readFile(manifest, 'utf8'), original);

    expectExit(run('create', archive, '--manifest', manifest, '--force'), 0);
    const replaced = JSON.parse(await readFile(manifest, 'utf8'));
    assert.deepEqual(replaced.files, [manifestEntry('file.txt', 'after')]);

    await writeFile(manifest, 'unrelated user data');
    expectExit(run('create', archive, '--manifest', manifest, '--force'), 2);
    assert.equal(await readFile(manifest, 'utf8'), 'unrelated user data');
});

test('will not overwrite a symlink to an existing valid manifest', async t => {
    const { directory, archive, manifest, run } = await fixture(t);
    await writeFile(join(archive, 'file.txt'), 'before');
    expectExit(run('create', archive, '--manifest', manifest), 0);
    const original = await readFile(manifest, 'utf8');
    const link = join(directory, 'manifest-link.json');
    if (!await symlinkOrSkip(t, manifest, link, 'file')) return;

    await writeFile(join(archive, 'file.txt'), 'after');
    expectExit(run('create', archive, '--manifest', link, '--force'), 2);
    assert.equal(await readFile(manifest, 'utf8'), original);
});

test('reports file symlinks as unsupported even when the target has matching bytes', async t => {
    const { directory, archive, manifest, run } = await fixture(t);
    const archivedFile = join(archive, 'file.txt');
    const outsideFile = join(directory, 'outside.txt');
    await writeFile(archivedFile, 'same');
    await writeFile(outsideFile, 'same');
    expectExit(run('create', archive, '--manifest', manifest), 0);
    await rm(archivedFile);
    if (!await symlinkOrSkip(t, outsideFile, archivedFile, 'file')) return;

    const result = run('verify', archive, '--manifest', manifest, '--json');
    expectExit(result, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checked, 0);
    assert.deepEqual(report.unsupported, ['file.txt']);
    assert.deepEqual(report.missing, []);
    const otherManifest = join(directory, 'second.json');
    expectExit(run('create', archive, '--manifest', otherManifest), 2);
    await assert.rejects(readFile(otherManifest), { code: 'ENOENT' });
});

test('does not scan through a directory junction or symlink', async t => {
    const { directory, archive, manifest, run } = await fixture(t);
    const archivedDirectory = join(archive, 'photos');
    const outsideDirectory = join(directory, 'outside');
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, 'photo.txt'), 'same');
    await mkdir(archivedDirectory);
    await writeFile(join(archivedDirectory, 'photo.txt'), 'same');
    expectExit(run('create', archive, '--manifest', manifest), 0);

    await rm(join(archivedDirectory, 'photo.txt'));
    await rmdir(archivedDirectory);
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    if (!await symlinkOrSkip(t, outsideDirectory, archivedDirectory, linkType)) return;

    const result = run('verify', archive, '--manifest', manifest, '--json');
    expectExit(result, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checked, 0);
    assert.deepEqual(report.unsupported, ['photos']);
    assert.deepEqual(report.unexpected, []);
});

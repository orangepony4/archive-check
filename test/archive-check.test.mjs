import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
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

test('sends progress to standard error without disturbing JSON output', async t => {
    const { archive, manifest, run } = await fixture(t);
    await writeFile(join(archive, 'match.txt'), 'abc');
    await writeFile(join(archive, 'size-change.txt'), 'before');
    const created = run('create', archive, '--manifest', manifest, '--progress');
    expectExit(created, 0);
    assert.match(created.stderr, /Scanned 2 paths; hashed 9 bytes\./);

    await writeFile(join(archive, 'size-change.txt'), 'longer than before');
    await writeFile(join(archive, 'extra.txt'), 'ignored');
    const verified = run('verify', archive, '--manifest', manifest, '--json', '--progress');
    expectExit(verified, 1);
    assert.match(verified.stderr, /Scanned 3 paths; hashed 3 bytes\./);
    assert.deepEqual(JSON.parse(verified.stdout), {
        checked: 1, missing: [], changed: ['size-change.txt'], unexpected: ['extra.txt'], unsupported: [],
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

test('suggests unique moves while preserving additions and removals', async t => {
    const { directory, run } = await fixture(t);
    const before = join(directory, 'before.json');
    const after = join(directory, 'after.json');
    const manifest = files => JSON.stringify({ version: 1, algorithm: 'sha256', files });
    await writeFile(before, manifest([
        manifestEntry('previous/unique.txt', 'unique'),
        manifestEntry('previous/ambiguous-a.txt', 'duplicate'),
        manifestEntry('previous/ambiguous-b.txt', 'duplicate'),
    ]));
    await writeFile(after, manifest([
        manifestEntry('current/ambiguous.txt', 'duplicate'),
        manifestEntry('current/unique.txt', 'unique'),
    ]));
    const result = run('compare', before, after, '--detect-moves', '--json');
    expectExit(result, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
        unchanged: 0,
        added: ['current/ambiguous.txt', 'current/unique.txt'],
        removed: ['previous/ambiguous-a.txt', 'previous/ambiguous-b.txt', 'previous/unique.txt'],
        changed: [],
        possibleMoves: [{ from: 'previous/unique.txt', to: 'current/unique.txt' }],
    });
    const textResult = run('compare', before, after, '--detect-moves');
    expectExit(textResult, 1);
    assert.match(textResult.stdout, /Possible moves: 1/);
    assert.match(textResult.stdout, /"previous\/unique\.txt" -> "current\/unique\.txt"/);
});

test('exports a sorted binary checksum list without reading the archive', async t => {
    const { manifest, run } = await fixture(t);
    const zeta = manifestEntry('zeta.bin', Buffer.from([0, 255, 128]));
    const spacedUnicode = manifestEntry('nested/cafe\u0301 photo.png', 'image');
    const dash = manifestEntry('-', 'regular file named dash');
    await writeFile(manifest, JSON.stringify({
        version: 1, algorithm: 'sha256', files: [zeta, spacedUnicode, dash],
    }));

    const result = run('export-sha256', manifest);
    expectExit(result, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout,
        `${dash.sha256} *./-\n${spacedUnicode.sha256} *${spacedUnicode.path}\n${zeta.sha256} *${zeta.path}\n`);
});

test('exports an empty list and rejects malformed input or unrelated options', async t => {
    const { manifest, run } = await fixture(t);
    await writeFile(manifest, JSON.stringify({ version: 1, algorithm: 'sha256', files: [] }));
    const empty = run('export-sha256', manifest);
    expectExit(empty, 0);
    assert.equal(empty.stdout, '');
    for (const args of [
        [], [manifest, manifest], [manifest, '--json'], [manifest, '--force'],
        [manifest, '--progress'], [manifest, '--detect-moves'], [manifest, '--manifest', manifest],
    ]) {
        const result = run('export-sha256', ...args);
        expectExit(result, 2);
        assert.equal(result.stdout, '');
    }

    await writeFile(manifest, JSON.stringify({
        version: 1, algorithm: 'sha256',
        files: [manifestEntry('valid.txt', 'valid'), manifestEntry('invalid\nname.txt', 'invalid')],
    }));
    const unsafe = run('export-sha256', manifest);
    expectExit(unsafe, 2);
    assert.equal(unsafe.stdout, '');
    await writeFile(manifest, '{');
    expectExit(run('export-sha256', manifest), 2);
});

test('prints the version from package metadata', async t => {
    const { run } = await fixture(t);
    const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const result = run('--version');
    expectExit(result, 0);
    assert.equal(result.stdout.trim(), packageMetadata.version);
});

test('matches canonically equivalent Unicode paths without rewriting the manifest', async t => {
    const { directory, archive, manifest, run } = await fixture(t);
    const dir = 'Résumé';
    const name = 'café.txt';
    await mkdir(join(archive, dir));
    await writeFile(join(archive, dir, name), 'same content');
    const [actualDir] = await readdir(archive);
    const [actualName] = await readdir(join(archive, actualDir));
    const actualPath = `${actualDir}/${actualName}`;
    const otherSpelling = part => part === part.normalize('NFC')
        ? part.normalize('NFD')
        : part.normalize('NFC');
    const otherPath = `${otherSpelling(actualDir)}/${otherSpelling(actualName)}`;
    assert.notEqual(actualPath, otherPath);
    assert.equal(actualPath.normalize('NFC'), otherPath.normalize('NFC'));

    expectExit(run('create', archive, '--manifest', manifest), 0);
    const created = JSON.parse(await readFile(manifest, 'utf8'));
    assert.deepEqual(created, {
        version: 1, algorithm: 'sha256', files: [manifestEntry(actualPath, 'same content')],
    });

    const alternateManifest = join(directory, 'alternate.json');
    await writeFile(alternateManifest, JSON.stringify({
        ...created, files: [manifestEntry(otherPath, 'same content')],
    }));
    const verified = run('verify', archive, '--manifest', alternateManifest, '--json');
    expectExit(verified, 0);
    assert.deepEqual(JSON.parse(verified.stdout), {
        checked: 1, missing: [], changed: [], unexpected: [], unsupported: [],
    });
    const compared = run('compare', manifest, alternateManifest, '--json');
    expectExit(compared, 0);
    assert.deepEqual(JSON.parse(compared.stdout), {
        unchanged: 1, added: [], removed: [], changed: [],
    });

    await writeFile(join(archive, actualDir, actualName), 'same length!');
    const changed = run('verify', archive, '--manifest', alternateManifest, '--json');
    expectExit(changed, 1);
    assert.deepEqual(JSON.parse(changed.stdout), {
        checked: 0, missing: [], changed: [actualPath], unexpected: [], unsupported: [],
    });
});

test('keeps case-only path differences visible on every filesystem', async t => {
    const { directory, archive, manifest, run } = await fixture(t);
    await writeFile(join(archive, 'Photo.txt'), 'same content');
    expectExit(run('create', archive, '--manifest', manifest), 0);
    const alternate = join(directory, 'alternate.json');
    await writeFile(alternate, JSON.stringify({
        version: 1, algorithm: 'sha256', files: [manifestEntry('photo.txt', 'same content')],
    }));

    const verified = run('verify', archive, '--manifest', alternate, '--json');
    expectExit(verified, 1);
    assert.deepEqual(JSON.parse(verified.stdout), {
        checked: 0, missing: ['photo.txt'], changed: [], unexpected: ['Photo.txt'], unsupported: [],
    });
    const compared = run('compare', manifest, alternate, '--json');
    expectExit(compared, 1);
    assert.deepEqual(JSON.parse(compared.stdout), {
        unchanged: 0, added: ['photo.txt'], removed: ['Photo.txt'], changed: [],
    });
});

test('rejects canonically ambiguous archive directories with disjoint files', async t => {
    const { directory, archive, manifest, run } = await fixture(t);
    const nfc = 'résumé';
    const nfd = nfc.normalize('NFD');
    await mkdir(join(archive, nfc));
    try {
        await mkdir(join(archive, nfd));
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        t.skip('The filesystem coalesces canonically equivalent directory names');
        return;
    }
    await writeFile(join(archive, nfc, 'first.txt'), 'first');
    await writeFile(join(archive, nfd, 'second.txt'), 'second');
    await writeFile(manifest, JSON.stringify({
        version: 1,
        algorithm: 'sha256',
        files: [manifestEntry(`${nfc}/first.txt`, 'first'), manifestEntry(`${nfc}/second.txt`, 'second')],
    }));

    expectExit(run('verify', archive, '--manifest', manifest, '--json'), 2);
    const output = join(directory, 'new.json');
    expectExit(run('create', archive, '--manifest', output), 2);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
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

test('hashes an entire file across read boundaries and detects a changed last byte', async t => {
    const { archive, manifest, run } = await fixture(t);
    const file = join(archive, 'chunks.bin');
    const bytes = Buffer.alloc(1024 * 1024 + 123);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = index % 251;
    }
    await writeFile(file, bytes);
    expectExit(run('create', archive, '--manifest', manifest), 0);
    assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')).files, [
        manifestEntry('chunks.bin', bytes),
    ]);
    expectExit(run('verify', archive, '--manifest', manifest), 0);

    bytes[bytes.length - 1] ^= 1;
    await writeFile(file, bytes);
    const result = run('verify', archive, '--manifest', manifest, '--json');
    expectExit(result, 1);
    assert.deepEqual(JSON.parse(result.stdout).changed, ['chunks.bin']);
});

test('optionally explains size and same-size content mismatches', async t => {
    const { archive, manifest, run } = await fixture(t);
    const sameSize = join(archive, 'a-content.txt');
    const otherSize = join(archive, 'z-size.txt');
    await writeFile(sameSize, 'old');
    await writeFile(otherSize, 'old');
    expectExit(run('create', archive, '--manifest', manifest), 0);
    await writeFile(sameSize, 'new');
    await writeFile(otherSize, 'longer');

    const result = run('verify', archive, '--manifest', manifest, '--details', '--json');
    expectExit(result, 1);
    const report = JSON.parse(result.stdout);
    const oldHash = manifestEntry('unused', 'old').sha256;
    assert.deepEqual(report.changed, ['a-content.txt', 'z-size.txt']);
    assert.deepEqual(report.details, [
        {
            path: 'a-content.txt', reason: 'sha256', expectedSize: '3', actualSize: '3',
            expectedSha256: oldHash, actualSha256: manifestEntry('unused', 'new').sha256,
        },
        {
            path: 'z-size.txt', reason: 'size', expectedSize: '3', actualSize: '6',
            expectedSha256: oldHash, actualSha256: null,
        },
    ]);
    const text = run('verify', archive, '--manifest', manifest, '--details');
    expectExit(text, 1);
    assert.match(text.stdout, /"z-size.txt": expected 3 bytes, found 6 bytes/);
    assert.match(text.stdout, /"a-content.txt": expected SHA-256/);
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
        [manifestEntry('Áͅ/first.txt', ''), manifestEntry('Áͅ/second.txt', '')],
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

test('rejects invalid UTF-8 without replacing bytes in paths', async t => {
    const { archive, manifest, run } = await fixture(t);
    const name = 'file-\uFFFD.txt';
    await writeFile(join(archive, name), 'content');
    expectExit(run('create', archive, '--manifest', manifest), 0);
    const valid = await readFile(manifest);
    const replacement = Buffer.from('\uFFFD');
    const index = valid.indexOf(replacement);
    assert.notEqual(index, -1);
    await writeFile(manifest, Buffer.concat([
        valid.subarray(0, index), Buffer.from([0xff]), valid.subarray(index + replacement.length),
    ]));
    const verified = run('verify', archive, '--manifest', manifest, '--json');
    expectExit(verified, 2);
    assert.match(verified.stderr, /Invalid UTF-8/);

    await writeFile(manifest, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]));
    expectExit(run('verify', archive, '--manifest', manifest, '--json'), 0);
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

test('explains an invalid manifest destination before scanning the archive', async t => {
    const { directory, run } = await fixture(t);
    const invalidManifest = join(directory, 'missing-parent', 'checksums.json');
    const result = run('create', 'also-missing-archive', '--manifest', invalidManifest);
    expectExit(result, 2);
    assert.match(result.stderr, /Manifest destination directory does not exist/);
    await assert.rejects(readFile(invalidManifest), { code: 'ENOENT' });
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

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/archive-check.mjs', import.meta.url));

async function fixture(t) {
    const tempRoot = await realpath(tmpdir());
    const directory = await mkdtemp(join(tempRoot, 'archive-scoped-'));
    t.after(async () => {
        assert.equal(dirname(await realpath(directory)), tempRoot);
        await rm(directory, { recursive: true, force: true });
    });

    const archive = join(directory, 'archive copy');
    const manifest = join(directory, 'snapshot.json');
    await mkdir(archive);

    function run(expectedExit, ...args) {
        const result = spawnSync(process.execPath, [cli, ...args], {
            cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, expectedExit, result.stderr || result.stdout);
        return result;
    }

    return {
        directory,
        archive,
        async put(path, contents) {
            const location = join(archive, path);
            await mkdir(dirname(location), { recursive: true });
            await writeFile(location, contents);
        },
        create(file = manifest) {
            run(0, 'create', archive, '--manifest', file);
        },
        verify(expectedExit, scope, file = manifest) {
            const result = run(expectedExit, 'verify', archive, '--manifest', file, '--under', scope, '--json');
            if (expectedExit === 2) {
                assert.equal(result.stdout, '');
                assert.doesNotMatch(result.stderr, /Unknown option/i);
                return result.stderr;
            }
            return JSON.parse(result.stdout);
        },
    };
}

test('checks only the selected subtree and excludes its in-tree manifest', async t => {
    const { archive, put, create, verify } = await fixture(t);
    await put('selected/deep/match.txt', 'same');
    await put('selected/deep/changed.txt', 'old');
    await put('selected/deep/missing.txt', 'lost');
    await put('selected/deep-backup/ignored.txt', 'another subtree');
    await put('selected/peer.txt', 'peer');
    const manifest = join(archive, 'selected', 'deep', 'snapshot.json');
    create(manifest);

    await put('selected/deep/changed.txt', 'new');
    await rm(join(archive, 'selected', 'deep', 'missing.txt'));
    await put('selected/deep/added.txt', 'new');
    await rm(join(archive, 'selected', 'deep-backup', 'ignored.txt'));
    await put('selected/peer.txt', 'changed outside scope');
    await put('outside/extra.txt', 'new outside scope');

    assert.deepEqual(verify(1, 'selected/deep', manifest), {
        checked: 1,
        missing: ['selected/deep/missing.txt'],
        changed: ['selected/deep/changed.txt'],
        unexpected: ['selected/deep/added.txt'],
        unsupported: [],
    });
});

test('matches NFC-equivalent scope spelling while retaining case sensitivity', async t => {
    const { archive, put, create, verify } = await fixture(t);
    await put('Media/Re\u0301sume\u0301/photo.txt', 'photo');
    const [folder] = await readdir(join(archive, 'Media'));
    const alternate = folder === folder.normalize('NFC') ? folder.normalize('NFD') : folder.normalize('NFC');
    assert.notEqual(alternate, folder);
    create();

    assert.deepEqual(verify(0, `Media/${alternate}`), {
        checked: 1, missing: [], changed: [], unexpected: [], unsupported: [],
    });
    verify(2, `media/${alternate}`);
});

test('distinguishes a missing known scope, an unknown scope, and an empty directory', async t => {
    const { archive, put, create, verify } = await fixture(t);
    await put('known/nested/lost.txt', 'lost');
    await put('another/present.txt', 'present');
    await mkdir(join(archive, 'empty'));
    create();

    await rm(join(archive, 'known', 'nested', 'lost.txt'));
    await rmdir(join(archive, 'known', 'nested'));
    await rmdir(join(archive, 'known'));
    assert.deepEqual(verify(1, 'known'), {
        checked: 0, missing: ['known/nested/lost.txt'], changed: [], unexpected: [], unsupported: [],
    });
    verify(2, 'unknown');
    assert.deepEqual(verify(0, 'empty'), {
        checked: 0, missing: [], changed: [], unexpected: [], unsupported: [],
    });
});

test('rejects a directory scope equal to or below a manifest file', async t => {
    const { archive, put, create, verify } = await fixture(t);
    const name = 'R\u00e9sum\u00e9';
    await put(`Media/${name}`, 'regular file in the reference');
    const [stored] = await readdir(join(archive, 'Media'));
    const alternate = stored === stored.normalize('NFC') ? stored.normalize('NFD') : stored.normalize('NFC');
    create();

    await rm(join(archive, 'Media', stored));
    await mkdir(join(archive, 'Media', alternate, 'child'), { recursive: true });
    for (const scope of [`Media/${stored}`, `Media/${alternate}`, `Media/${alternate}/child`]) {
        const error = verify(2, scope);
        assert.match(error, /scope.*conflicts with manifest file/i);
        assert.ok(error.includes(JSON.stringify(`Media/${stored}`)), error);
    }

    const empty = { checked: 0, missing: [], changed: [], unexpected: [], unsupported: [] };
    await mkdir(join(archive, 'Media', `${alternate}-other`));
    assert.deepEqual(verify(0, `Media/${stored}-other`), empty);

    await rmdir(join(archive, 'Media', alternate, 'child'));
    await rmdir(join(archive, 'Media', alternate));
    const lowercase = alternate.toLowerCase();
    await mkdir(join(archive, 'Media', lowercase));
    assert.deepEqual(verify(0, `Media/${lowercase}`), empty);
});

test('rejects absolute and traversing scope paths', async t => {
    const { archive, directory, put, create, verify } = await fixture(t);
    await put('valid/file.txt', 'file');
    await put('outside/file.txt', 'inside root');
    await mkdir(join(directory, 'outside'));
    await writeFile(join(directory, 'outside', 'file.txt'), 'outside root');
    create();

    const absolute = join(archive, 'outside').replaceAll('\\', '/');
    for (const scope of ['../outside', 'valid/../outside', absolute, '/outside', 'C:/outside', 'valid\\outside']) {
        assert.match(verify(2, scope), /under|scope|relative/i);
    }
});

test('rejects a scope that matches two canonically equivalent directory names', async t => {
    const { archive, put, create, verify } = await fixture(t);
    const nfc = 'r\u00E9sum\u00E9';
    const nfd = nfc.normalize('NFD');
    await put(`${nfc}/one.txt`, 'one');
    create();
    try {
        await mkdir(join(archive, nfd));
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        t.skip('The filesystem coalesces canonically equivalent directory names');
        return;
    }
    await put(`${nfd}/two.txt`, 'two');

    assert.match(verify(2, nfc), /multiple archive entries/i);
});

test('reports a selected symlink ancestor and never follows unrelated links', async t => {
    const { directory, archive, put, create, verify } = await fixture(t);
    await put('outer/inner/file.txt', 'same bytes');
    await put('safe/file.txt', 'unchanged');
    create();

    const external = join(directory, 'external');
    await mkdir(join(external, 'inner'), { recursive: true });
    await writeFile(join(external, 'inner', 'file.txt'), 'same bytes');
    await rm(join(archive, 'outer', 'inner', 'file.txt'));
    await rmdir(join(archive, 'outer', 'inner'));
    await rmdir(join(archive, 'outer'));
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
        await symlink(external, join(archive, 'outer'), linkType);
        await symlink(external, join(archive, 'unrelated-link'), linkType);
    } catch (error) {
        if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
            t.skip(`Link creation is unavailable (${error.code})`);
            return;
        }
        throw error;
    }

    assert.deepEqual(verify(1, 'outer/inner'), {
        checked: 0, missing: ['outer/inner/file.txt'], changed: [], unexpected: [], unsupported: ['outer'],
    });
    assert.deepEqual(verify(0, 'safe'), {
        checked: 1, missing: [], changed: [], unexpected: [], unsupported: [],
    });
});

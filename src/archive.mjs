import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const statOptions = { bigint: true };
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const maxFileSize = BigInt(Number.MAX_SAFE_INTEGER);
const windowsDeviceName = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;

function isPortableSegment(segment) {
    return segment.length > 0
        && !/[<>:"\\|?*\x00-\x1f\uD800-\uDFFF]/u.test(segment)
        && !/[. ]$/.test(segment)
        && !windowsDeviceName.test(segment.split('.')[0].replace(/ +$/, ''));
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateManifest(manifest) {
    if (!isRecord(manifest) || manifest.version !== 1 || manifest.algorithm !== 'sha256'
        || !Array.isArray(manifest.files)) {
        throw new Error('Expected a version 1 SHA-256 manifest with a files array.');
    }

    // Track each directory component so aliases such as A/x and a/y are rejected.
    const rootNames = new Map();
    for (const file of manifest.files) {
        if (!isRecord(file) || typeof file.path !== 'string'
            || !Number.isSafeInteger(file.size) || file.size < 0
            || typeof file.sha256 !== 'string' || file.sha256.length !== 64
            || /[^0-9a-f]/.test(file.sha256)) {
            throw new Error('Each manifest entry must have a path, a non-negative byte size, and a lowercase SHA-256 digest.');
        }
        const segments = file.path.split('/');
        if (!segments.every(isPortableSegment)) {
            throw new Error(`Unsafe or nonportable manifest path ${JSON.stringify(file.path)}.`);
        }

        let names = rootNames;
        for (let index = 0; index < segments.length; index++) {
            const name = segments[index];
            const key = name.toUpperCase().normalize('NFC');
            const isFile = index === segments.length - 1;
            let entry = names.get(key);
            if (entry && (entry.name !== name || isFile || entry.children === null)) {
                throw new Error(`Duplicate or conflicting manifest path ${JSON.stringify(file.path)}.`);
            }
            if (!entry) {
                entry = { name, children: isFile ? null : new Map() };
                names.set(key, entry);
            }
            names = entry.children;
        }
    }
}

function assertUnchanged(before, after, path) {
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw new Error(`Archive entry changed during the scan: ${JSON.stringify(path || '.')}.`);
    }
}

async function* walkDirectory(absolutePath, archivePath, directoryStat, excludePath) {
    const names = await readdir(absolutePath, { encoding: 'buffer' });
    for (const bytes of names) {
        const name = bytes.toString('utf8');
        if (!Buffer.from(name).equals(bytes)) {
            throw new Error(`Directory ${JSON.stringify(archivePath || '.')} contains a name that is invalid UTF-8 (hex: ${bytes.toString('hex')}).`);
        }
        const path = archivePath ? `${archivePath}/${name}` : name;
        if (!isPortableSegment(name)) {
            yield { path };
            continue;
        }
        const location = join(absolutePath, name);
        const stat = await lstat(location, statOptions);
        if (stat.isDirectory()) {
            yield* walkDirectory(location, path, stat, excludePath);
        } else if (stat.isFile()) {
            if (location !== excludePath) {
                yield { path, location, stat };
            }
        } else {
            yield { path };
        }
    }
    assertUnchanged(directoryStat, await lstat(absolutePath, statOptions), archivePath);
}

async function resolveExclusion(excludePath) {
    if (excludePath === undefined) return undefined;
    if (typeof excludePath !== 'string' || !isAbsolute(excludePath)) {
        throw new Error('The excluded manifest path must be absolute.');
    }

    const location = resolve(excludePath);
    let stat;
    try {
        stat = await lstat(location, statOptions);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
        throw error;
    }
    if (!stat.isFile()) return undefined;

    const canonicalPath = await realpath(location);
    assertUnchanged(stat, await lstat(canonicalPath, statOptions), excludePath);
    return canonicalPath;
}

async function* walkArchive(root, excludePath) {
    const absoluteRoot = resolve(root);
    const stat = await lstat(absoluteRoot, statOptions);
    if (!stat.isDirectory()) {
        throw new Error('The archive root must be a regular directory.');
    }
    const canonicalRoot = await realpath(absoluteRoot);
    const exclusion = await resolveExclusion(excludePath);
    assertUnchanged(stat, await lstat(canonicalRoot, statOptions), '.');
    yield* walkDirectory(canonicalRoot, '', stat, exclusion);
}

async function hashFile({ location, path, stat }) {
    const file = await open(location, readFlags);
    try {
        assertUnchanged(stat, await file.stat(statOptions), path);
        const hash = createHash('sha256');
        let bytesRead = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
            hash.update(chunk);
            bytesRead += chunk.length;
        }
        assertUnchanged(stat, await file.stat(statOptions), path);
        assertUnchanged(stat, await lstat(location, statOptions), path);
        if (BigInt(bytesRead) !== stat.size) {
            throw new Error(`Archive entry size changed during the scan: ${JSON.stringify(path)}.`);
        }
        return hash.digest('hex');
    } finally {
        await file.close();
    }
}

export async function createManifest(root, { excludePath } = {}) {
    const files = [];
    for await (const entry of walkArchive(root, excludePath)) {
        if (!entry.stat) {
            throw new Error(`Unsupported archive entry ${JSON.stringify(entry.path)}.`);
        }
        if (entry.stat.size > maxFileSize) {
            throw new Error(`Archive entry exceeds the manifest size limit: ${JSON.stringify(entry.path)}.`);
        }
        files.push({ path: entry.path, size: Number(entry.stat.size), sha256: await hashFile(entry) });
    }
    files.sort((a, b) => {
        if (a.path === b.path) return 0;
        return a.path < b.path ? -1 : 1;
    });
    const manifest = { version: 1, algorithm: 'sha256', files };
    validateManifest(manifest);
    return manifest;
}

export async function verifyManifest(root, manifest, { excludePath } = {}) {
    validateManifest(manifest);
    const remaining = new Map(manifest.files.map(file => [file.path, file]));
    const result = { checked: 0, missing: [], changed: [], unexpected: [], unsupported: [] };
    for await (const entry of walkArchive(root, excludePath)) {
        const expected = remaining.get(entry.path);
        remaining.delete(entry.path);
        if (!entry.stat) {
            result.unsupported.push(entry.path);
        } else if (!expected) {
            result.unexpected.push(entry.path);
        } else if (entry.stat.size !== BigInt(expected.size) || await hashFile(entry) !== expected.sha256) {
            result.changed.push(entry.path);
        } else {
            result.checked++;
        }
    }
    result.missing = [...remaining.keys()].sort();
    result.changed.sort();
    result.unexpected.sort();
    result.unsupported.sort();
    return result;
}

export function compareManifests(previous, current) {
    validateManifest(previous);
    validateManifest(current);

    const remaining = new Map(previous.files.map(file => [file.path, file]));
    const result = { unchanged: 0, added: [], removed: [], changed: [] };
    for (const file of current.files) {
        const prior = remaining.get(file.path);
        remaining.delete(file.path);
        if (!prior) {
            result.added.push(file.path);
        } else if (prior.size !== file.size || prior.sha256 !== file.sha256) {
            result.changed.push(file.path);
        } else {
            result.unchanged++;
        }
    }
    result.added.sort();
    result.removed = [...remaining.keys()].sort();
    result.changed.sort();
    return result;
}

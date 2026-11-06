import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const statOptions = { bigint: true };
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const maxFileSize = BigInt(Number.MAX_SAFE_INTEGER);
const hashBufferSize = 256 * 1024;
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

function unicodePathKey(path) {
    return path.normalize('NFC');
}

function portableNameKey(name) {
    return name.normalize('NFC').toUpperCase().normalize('NFC');
}

function registerPath(names, segments, keyForName, source) {
    // Track directory spellings too, so aliases with disjoint children cannot merge.
    for (let index = 0; index < segments.length; index++) {
        const name = segments[index];
        const key = keyForName(name);
        const isFile = index === segments.length - 1;
        let entry = names.get(key);
        if (entry && (entry.name !== name || isFile || entry.children === null)) {
            throw new Error(`Duplicate or conflicting ${source} path ${JSON.stringify(segments.join('/'))}.`);
        }
        if (!entry) {
            entry = { name, children: isFile ? null : new Map() };
            names.set(key, entry);
        }
        names = entry.children;
    }
}

export function validateManifest(manifest) {
    if (!isRecord(manifest) || manifest.version !== 1 || manifest.algorithm !== 'sha256'
        || !Array.isArray(manifest.files)) {
        throw new Error('Expected a version 1 SHA-256 manifest with a files array.');
    }

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

        registerPath(rootNames, segments, portableNameKey, 'manifest');
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

async function hashFile({ location, path, stat }, buffer) {
    const file = await open(location, readFlags);
    try {
        assertUnchanged(stat, await file.stat(statOptions), path);
        const hash = createHash('sha256');
        const expectedSize = Number(stat.size);
        let bytesRead = 0;
        while (bytesRead <= expectedSize) {
            // Read at most one byte past the observed size to detect a growing file.
            const length = Math.min(buffer.length, expectedSize - bytesRead + 1);
            const { bytesRead: count } = await file.read(buffer, 0, length, null);
            if (count === 0) break;
            bytesRead += count;
            if (bytesRead > expectedSize) break;
            hash.update(buffer.subarray(0, count));
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

function makeProgressReporter(onProgress) {
    if (onProgress === undefined) return undefined;
    if (typeof onProgress !== 'function') {
        throw new TypeError('onProgress must be a function.');
    }

    let scanned = 0;
    let hashedBytes = 0;
    return (bytes = 0) => {
        scanned++;
        hashedBytes += bytes;
        onProgress({ scanned, hashedBytes });
    };
}

export async function createManifest(root, { excludePath, onProgress } = {}) {
    const reportProgress = makeProgressReporter(onProgress);
    const buffer = Buffer.allocUnsafe(hashBufferSize);
    const files = [];
    for await (const entry of walkArchive(root, excludePath)) {
        if (!entry.stat) {
            reportProgress?.();
            throw new Error(`Unsupported archive entry ${JSON.stringify(entry.path)}.`);
        }
        if (entry.stat.size > maxFileSize) {
            throw new Error(`Archive entry exceeds the manifest size limit: ${JSON.stringify(entry.path)}.`);
        }
        const size = Number(entry.stat.size);
        files.push({ path: entry.path, size, sha256: await hashFile(entry, buffer) });
        reportProgress?.(size);
    }
    files.sort((a, b) => {
        if (a.path === b.path) return 0;
        return a.path < b.path ? -1 : 1;
    });
    const manifest = { version: 1, algorithm: 'sha256', files };
    validateManifest(manifest);
    return manifest;
}

export async function verifyManifest(root, manifest, { excludePath, onProgress } = {}) {
    validateManifest(manifest);
    const reportProgress = makeProgressReporter(onProgress);
    const buffer = Buffer.allocUnsafe(hashBufferSize);
    const remaining = new Map(manifest.files.map(file => [unicodePathKey(file.path), file]));
    const actualNames = new Map();
    const unsupportedKeys = new Set();
    const result = { checked: 0, missing: [], changed: [], unexpected: [], unsupported: [] };
    for await (const entry of walkArchive(root, excludePath)) {
        const key = unicodePathKey(entry.path);
        if (!entry.stat) {
            unsupportedKeys.add(key);
            result.unsupported.push(entry.path);
            reportProgress?.();
            continue;
        }

        registerPath(actualNames, entry.path.split('/'), unicodePathKey, 'archive');
        const expected = remaining.get(key);
        remaining.delete(key);
        let hashedBytes = 0;
        if (!expected) {
            result.unexpected.push(entry.path);
        } else if (entry.stat.size !== BigInt(expected.size)) {
            result.changed.push(entry.path);
        } else {
            const sha256 = await hashFile(entry, buffer);
            hashedBytes = expected.size;
            if (sha256 === expected.sha256) {
                result.checked++;
            } else {
                result.changed.push(entry.path);
            }
        }
        reportProgress?.(hashedBytes);
    }
    for (const [key, file] of remaining) {
        if (!unsupportedKeys.has(key)) {
            result.missing.push(file.path);
        }
    }
    result.missing.sort();
    result.changed.sort();
    result.unexpected.sort();
    result.unsupported.sort();
    return result;
}

function uniqueContentPaths(files) {
    const paths = new Map();
    for (const { path, size, sha256 } of files) {
        const signature = `${size}:${sha256}`;
        paths.set(signature, paths.has(signature) ? null : path);
    }
    return paths;
}

function findPossibleMoves(removedFiles, addedFiles) {
    const removedPaths = uniqueContentPaths(removedFiles);
    const addedPaths = uniqueContentPaths(addedFiles);
    const moves = [];
    for (const [signature, from] of removedPaths) {
        const to = addedPaths.get(signature);
        if (from && to) {
            moves.push({ from, to });
        }
    }
    moves.sort((a, b) => {
        if (a.from === b.from) return 0;
        return a.from < b.from ? -1 : 1;
    });
    return moves;
}

export function compareManifests(previous, current, { detectMoves = false } = {}) {
    validateManifest(previous);
    validateManifest(current);

    const remaining = new Map(previous.files.map(file => [unicodePathKey(file.path), file]));
    const addedFiles = detectMoves ? [] : undefined;
    const result = { unchanged: 0, added: [], removed: [], changed: [] };
    for (const file of current.files) {
        const key = unicodePathKey(file.path);
        const prior = remaining.get(key);
        remaining.delete(key);
        if (!prior) {
            result.added.push(file.path);
            addedFiles?.push(file);
        } else if (prior.size !== file.size || prior.sha256 !== file.sha256) {
            result.changed.push(file.path);
        } else {
            result.unchanged++;
        }
    }
    result.added.sort();
    result.removed = [...remaining.values()].map(file => file.path).sort();
    result.changed.sort();
    if (addedFiles) {
        result.possibleMoves = findPossibleMoves(remaining.values(), addedFiles);
    }
    return result;
}

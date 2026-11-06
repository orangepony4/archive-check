#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compareManifests, createManifest, validateManifest, verifyManifest } from '../src/archive.mjs';

const usage = `Usage:
  archive-check create <folder> --manifest <file> [--force] [--progress]
  archive-check verify <folder> --manifest <file> [--json] [--progress]
  archive-check compare <before.json> <after.json> [--json]

Commands:
  create   Record relative paths, sizes and SHA-256 hashes.
  verify   Report missing, changed, unexpected or unsupported paths.
  compare  Report added, removed and changed paths between two manifests.

Options:
  --manifest <file>  Path to the JSON manifest.
  --force           Replace an existing valid manifest when creating.
  --progress        Print scan progress to standard error.
  --json            Print the verification or comparison report as JSON.
  -h, --help        Show this help.`;

async function statIfPresent(file) {
    try {
        return await lstat(file, { bigint: true });
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function readManifest(file) {
    const before = await lstat(file, { bigint: true });
    if (!before.isFile()) {
        throw new Error(`Manifest must be a regular file: ${file}`);
    }
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const handle = await open(file, flags);
    let bytes;
    try {
        if (!sameFile(before, await handle.stat({ bigint: true }))) {
            throw new Error(`Manifest changed before reading: ${file}`);
        }
        bytes = await handle.readFile();
        if (!sameFile(before, await handle.stat({ bigint: true }))) {
            throw new Error(`Manifest changed during reading: ${file}`);
        }
    } finally {
        await handle.close();
    }
    let manifest;
    try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        manifest = JSON.parse(content);
    } catch (error) {
        throw new Error(`Invalid UTF-8 or JSON in manifest: ${error.message}`);
    }
    validateManifest(manifest);
    return manifest;
}

function sameFile(before, after) {
    return after?.isFile() && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(
        key => after[key] === before[key]
    );
}

async function checkDestination(file, force) {
    const parent = dirname(file);
    const parentStat = await stat(parent).catch(error => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
    });
    if (!parentStat?.isDirectory()) {
        throw new Error(`Manifest destination directory does not exist: ${parent}`);
    }
    const existing = await statIfPresent(file);
    if (!existing) return null;
    if (!force) {
        throw new Error(`Manifest destination already exists: ${file}. Use --force to replace a valid manifest.`);
    }
    if (!existing.isFile()) {
        throw new Error(`Manifest destination must be a regular file: ${file}`);
    }
    try {
        await readManifest(file);
    } catch (error) {
        throw new Error(`Refusing to overwrite a file that is not a valid manifest: ${error.message}`);
    }
    return existing;
}

async function writeManifest(file, manifest, previous) {
    const temporary = join(dirname(file), `.archive-check-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
        try {
            await handle.writeFile(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        if (previous) {
            const current = await statIfPresent(file);
            if (!sameFile(previous, current)) {
                throw new Error(`Manifest destination changed during the scan: ${file}`);
            }
            await rename(temporary, file);
        } else {
            try {
                await link(temporary, file);
            } catch (error) {
                // FAT and some network filesystems do not support hard links.
                if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw error;
                await copyFile(temporary, file, constants.COPYFILE_EXCL);
            }
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

function reportResult(report, json, countKey, countLabel) {
    const { [countKey]: count, ...groups } = report;
    if (json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`${countLabel}: ${count}`);
        for (const [label, paths] of Object.entries(groups)) {
            console.log(`${label[0].toUpperCase()}${label.slice(1)}: ${paths.length}`);
            for (const path of paths) {
                console.log(`  ${JSON.stringify(path)}`);
            }
        }
    }
    return Object.values(groups).some(paths => paths.length > 0) ? 1 : 0;
}

function createProgressReporter() {
    let latest = { scanned: 0, hashedBytes: 0 };
    let lastPrinted;
    let nextUpdate = performance.now() + 1000;

    function print() {
        if (latest !== lastPrinted) {
            console.error(`Scanned ${latest.scanned} paths; hashed ${latest.hashedBytes} bytes.`);
            lastPrinted = latest;
        }
    }

    return {
        onProgress(summary) {
            latest = summary;
            const now = performance.now();
            if (now >= nextUpdate) {
                print();
                nextUpdate = now + 1000;
            }
        },
        finish: print,
    };
}

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            help: { type: 'boolean', short: 'h' },
            manifest: { type: 'string' },
            force: { type: 'boolean' },
            json: { type: 'boolean' },
            progress: { type: 'boolean' },
        },
    });
    if (values.help) {
        console.log(usage);
        return 0;
    }
    const [command, folder, after] = positionals;
    if (command === 'compare') {
        if (positionals.length !== 3 || !folder || !after ||
            values.manifest !== undefined || values.force || values.progress) {
            throw new Error('Expected compare <before.json> <after.json> [--json]. See --help.');
        }
        const [previous, current] = await Promise.all([
            readManifest(resolve(folder)),
            readManifest(resolve(after)),
        ]);
        return reportResult(compareManifests(previous, current), values.json, 'unchanged', 'Unchanged files');
    }
    if (positionals.length !== 2 || !folder || !values.manifest ||
        !['create', 'verify'].includes(command)) {
        throw new Error('Expected create, verify or compare with its required arguments. See --help.');
    }
    if ((command === 'create' && values.json) || (command === 'verify' && values.force)) {
        throw new Error('--json applies to verify and --force applies to create. See --help.');
    }

    const root = resolve(folder);
    const file = resolve(values.manifest);
    const progress = values.progress ? createProgressReporter() : undefined;
    const options = { excludePath: file, onProgress: progress?.onProgress };
    if (command === 'create') {
        const previous = await checkDestination(file, values.force);
        const manifest = await createManifest(root, options);
        await writeManifest(file, manifest, previous);
        progress?.finish();
        console.log(`Wrote ${manifest.files.length} file entries to ${file}`);
        return 0;
    }

    const manifest = await readManifest(file);
    const report = await verifyManifest(root, manifest, options);
    progress?.finish();
    return reportResult(report, values.json, 'checked', 'Matching files');
}

try {
    process.exitCode = await main();
} catch (error) {
    console.error(`archive-check: ${error.message}`);
    process.exitCode = 2;
}

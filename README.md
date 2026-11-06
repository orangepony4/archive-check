# Archive Check

[![Tests](https://github.com/orangepony4/archive-check/actions/workflows/test.yml/badge.svg)](https://github.com/orangepony4/archive-check/actions/workflows/test.yml)

Create a SHA-256 inventory of a folder, then check another copy against it. Archive Check detects missing files, extra files, and content changes even when the file sizes still match. It runs locally and works with any regular file type.

## Quick start

Install Node.js 20 or newer. Clone or download this repository. The CLI has no package dependencies.

```sh
git clone https://github.com/orangepony4/archive-check.git
cd archive-check
node bin/archive-check.mjs create "/path/to/original" --manifest backup.json
node bin/archive-check.mjs verify "/path/to/copy" --manifest backup.json
```

On Windows, paths such as `"D:\Photos"` and `"E:\Photos Backup"` work in the same commands. The manifest records paths relative to the archived folder, so the original and the copy can have different locations or drive letters.

To run `archive-check` from any folder, download the `.tgz` from the [releases page](https://github.com/orangepony4/archive-check/releases/latest) and install it with npm. For example, for version 0.4.0:

```sh
npm install --global ./archive-check-0.4.0.tgz
archive-check --help
```

For a machine-readable report, add `--json` to `verify`.

```json
{
  "checked": 12,
  "missing": ["2023/trip.jpg"],
  "changed": ["2024/notes.txt"],
  "unexpected": ["copy-log.txt"],
  "unsupported": []
}
```

`checked` counts files that match both the size and the SHA-256 in the manifest. Verification exits with code `0` for a match, `1` for differences, and `2` for an invalid manifest, an inaccessible folder, or another execution error.

Add `--progress` to either scan command to see the number of paths scanned and bytes hashed so far. Updates appear as files finish and go to standard error, so `verify --json --progress` still writes a clean JSON report to standard output.

Add `--details` to `verify` to see whether a changed file differs in size or SHA-256. In JSON mode, the extra `details` array contains the expected and actual sizes as decimal strings and the hashes. When the size already differs, the file is skipped by the hasher and `actualSha256` is `null`.

### Check one subdirectory

For a large archive, use `--under` to verify a single subdirectory against the original manifest.

```sh
node bin/archive-check.mjs verify "/path/to/copy" --manifest backup.json --under "photos/2024"
```

The scope uses a relative path with `/` separators, including on Windows. Archive Check reads the selected subtree and reports paths relative to the archive root. Files elsewhere are outside this check. If the requested directory is missing, any matching manifest entries are reported as missing.

## Compare two snapshots

Use `compare` when you have two manifests and want to see what changed without reading either folder.

```sh
node bin/archive-check.mjs compare previous.json current.json
```

The report lists added, removed, and changed paths, plus a count of unchanged files. A rename appears as a removal and an addition. Canonically equivalent Unicode spellings match, while case changes count as renames. Add `--json` for structured output. The exit codes match those of `verify`.

Add `--detect-moves` to list possible renames alongside the raw differences. A candidate needs exactly one removed and one added file with the same size and SHA-256. Groups with duplicate content on either side are left ambiguous.

## Export a checksum list

On a system with GNU `sha256sum`, export the manifest to a text file and check the copy from its root directory.

```sh
node bin/archive-check.mjs export-sha256 backup.json > "/path/to/archive.sha256"
(cd "/path/to/copy" && sha256sum -c "/path/to/archive.sha256")
```

The export reads the manifest alone and writes its checksums to standard output. It exits with code `0` on success and `2` on invalid input or execution errors. The list keeps the original filename spelling. Use Archive Check's `verify` to detect extra paths, match canonically equivalent Unicode names, or verify an empty archive.

## What the inventory covers

- The manifest contains relative paths, byte sizes, and SHA-256 hashes. Keep a trusted copy of it to use as your reference after copying or restoring the folder.
- Archive Check excludes the exact file passed with `--manifest` if it is inside the scanned folder. Store the reference manifest outside both copies if you want to verify their contents independently of the manifest. The same archive yields the same manifest while the paths and bytes stay the same.
- Empty directories, permissions, timestamps, and NTFS alternate data streams are outside the inventory. Creating a manifest rejects symbolic links and special files. Verification reports them under `unsupported`.
- Both commands read the archived files. `create` writes the specified manifest and protects any existing file there. Use `--force` to replace a valid Archive Check manifest after intentionally changing the reference snapshot.
- Scan a stable folder after a copy finishes. A scan reads files one at a time and cannot take a filesystem snapshot.

## Manifest format

```json
{
  "version": 1,
  "algorithm": "sha256",
  "files": [
    {
      "path": "docs/empty.txt",
      "size": 0,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ]
}
```

Manifests use UTF-8 JSON. Each path is relative to the archive and uses `/` as its separator. Archive Check keeps the original spelling in the manifest and matches canonically equivalent Unicode paths across filesystems. Matching remains case-sensitive. The size is a non-negative safe integer in bytes, and the hash contains 64 lowercase hexadecimal characters. Archive Check rejects conflicting names, path traversal, and Windows-reserved path segments. The destination filesystem still determines which filename lengths it can store.

## Development

Run `npm test` to exercise the CLI against temporary directories. The integration tests use synthetic files and require no external services.

Released under the [MIT License](LICENSE).

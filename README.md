# Archive Check

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

## Compare two snapshots

Use `compare` when you have two manifests and want to see what changed without reading either folder.

```sh
node bin/archive-check.mjs compare previous.json current.json
```

The report lists added, removed, and changed paths, plus a count of unchanged files. Paths are matched exactly, so renaming a file appears as a removal and an addition. Add `--json` for structured output. The exit codes match those of `verify`.

## What the inventory covers

- The manifest contains relative paths, byte sizes, and SHA-256 hashes. Keep a trusted copy of it to use as your reference after copying or restoring the folder.
- If the manifest is stored inside the archive, Archive Check excludes the manifest file itself. The same archive yields the same manifest while the paths and bytes stay the same.
- Empty directories and metadata such as permissions and timestamps are outside the inventory. Creating a manifest rejects symbolic links and special files. Verification reports them under `unsupported`.
- Both commands read the archived files. `create` writes the specified manifest and protects any existing file there. Use `--force` to replace a valid Archive Check manifest after intentionally changing the reference snapshot.
- Scan a stable folder after a copy finishes. A scan reads files one at a time and cannot take a filesystem snapshot.

## Development

Run `npm test` to exercise the CLI against temporary directories. The integration tests use synthetic files and require no external services.

Released under the [MIT License](LICENSE).

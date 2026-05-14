# read-only-bash

A pi-coding-agent extension that registers a `read_only_bash` tool: a bash
shell where the entire filesystem is mounted read-only and network access is
fully blocked.

Enforcement is done at the **kernel level** via
[bubblewrap](https://github.com/containers/bubblewrap) (Linux mount namespaces).
No command analysis is performed — any write attempt receives an `EROFS` error
from the OS regardless of what the command is.

## How it works

Every `read_only_bash` call runs inside a `bwrap` sandbox:

| Flag | Effect |
|------|--------|
| `--ro-bind / /` | Entire filesystem bind-mounted read-only |
| `--proc /proc` | Procfs (needed by `ps`, many other tools) |
| `--dev /dev` | Device nodes |
| `--unshare-net` | Network namespace isolated — all network calls fail |
| `--die-with-parent` | Sandbox killed if the parent pi process dies |
| `--chdir <cwd>` | Working directory preserved |

`/tmp` is **not** replaced with a fresh tmpfs. The real host `/tmp` is visible
read-only, so files placed there by other tools are accessible via `grep`,
`find`, `cat`, etc.

The tool wraps `createBashToolDefinition` from pi internals, so it inherits the
same streaming output, truncation handling (2000 lines / 50 KB), timeout
support, and TUI rendering as the built-in `bash` tool.

## Setup

### Linux

Install bubblewrap:

```bash
# Debian / Ubuntu
sudo apt install bubblewrap

# Fedora / RHEL
sudo dnf install bubblewrap

# Arch Linux
sudo pacman -S bubblewrap
```

Verify:

```bash
bwrap --ro-bind / / --proc /proc --dev /dev --unshare-net --chdir "$PWD" bash -c "echo ok"
# expected output: ok
```

### Windows

Two levels of setup are required because `bwrap` is a Linux tool. The
extension runs it inside WSL (Windows Subsystem for Linux).

#### Level 1 — Install WSL 2

Open PowerShell **as Administrator**:

```powershell
wsl --install
```

This installs WSL 2 and Ubuntu by default. Reboot when prompted, then complete
the first-launch setup (create a Linux username and password).

> **WSL version:** WSL 2 is required. WSL 1 does not support the mount
> namespaces that bubblewrap relies on. To upgrade an existing WSL 1
> installation:
> ```powershell
> wsl --set-default-version 2
> wsl --set-version Ubuntu 2   # substitute your distro name if different
> ```

Verify:

```powershell
wsl -- echo "WSL ok"
# expected output: WSL ok
```

#### Level 2 — Install bwrap inside WSL

Open a WSL terminal:

```bash
sudo apt update && sudo apt install bubblewrap
```

Verify inside WSL:

```bash
bwrap --ro-bind / / --proc /proc --dev /dev --unshare-net --chdir "$PWD" bash -c "echo ok"
# expected output: ok
```

#### Running pi on Windows

**Recommended:** run pi from inside a WSL terminal. In that case
`process.platform` is `'linux'`, bwrap runs directly, and all paths are
Linux-style with no conversion needed.

**Also supported:** running pi natively on Windows (Git Bash). The extension
detects `process.platform === 'win32'` and automatically calls `wsl -- bwrap`
instead, converting the working directory to its WSL equivalent:

```
C:\Users\thomas\project  →  /mnt/c/Users/thomas/project
```

In this mode, commands that use absolute paths must use WSL-style paths
(`/mnt/c/...`) rather than Git Bash paths (`/c/...`). Relative paths work
without any issue.

## Usage notes

### What works

```bash
ls -la
cat src/index.ts
grep -r "TODO" .
rg "pattern" --type ts
find . -name "*.json" -not -path "*/node_modules/*"
git log --oneline -20
git diff HEAD~1 HEAD
git show HEAD:path/to/file.ts
wc -l src/**/*.ts
head -50 README.md
stat package.json
```

Reading files from `/tmp`:

```bash
ls /tmp
cat /tmp/some-file
grep -r "pattern" /tmp/some-repo/src/
```

### What does not work

**Write operations** — the OS returns `EROFS`:

```bash
echo "x" > file.txt    # EROFS
touch newfile           # EROFS
mkdir newdir            # EROFS
npm install             # EROFS
git add .               # EROFS
```

**Network access** — the network namespace is isolated:

```bash
curl https://example.com   # Could not resolve host
ping 8.8.8.8               # Network unreachable
```

**Commands that need to write to `/tmp`** — since `/tmp` is the real read-only
host directory, operations that create intermediate files there will fail:

```bash
sort -o /tmp/sorted.txt input.txt   # EROFS
```

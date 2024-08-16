# bun-import-check

Checks dependency cycles in imports, supporting monorepos.

## Setup

[Bun](https://bun.sh) is a fast all-in-one JavaScript runtime, go install that first.

```bash
bun install
```

## Usage

```bash
bunx chase/bun-import-check#HEAD ENTRY_POINT
```

For more information on usage, check `--help`

```bash
bunx chase/bun-import-check#HEAD --help
```

Or when developing

```bash
./src/cli.ts ENTRY_POINT
```

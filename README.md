# type-coverage
> Measure TypeScript type coverage. Find every `any` lurking in your codebase.

```bash
npx type-coverage
```

```
type-coverage · 87 TypeScript files
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Overall coverage: 84.2%  ████████████████░░░░

  Worst files:
  src/legacy/api.ts       41.2%  ██████████░░░░  18 any usages
  src/utils/parser.ts     63.7%  █████████████░  7 any usages

  any breakdown:
    explicit `: any`   23
    `as any` casts     11
    untyped params     31

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
84.2% coverage · 73 any usages
```

## Commands
| Command | Description |
|---------|-------------|
| `type-coverage` | Measure type coverage |
| `--threshold 80` | Exit 1 if below N% |
| `--detail` | Show every any with location |
| `--fix-hints` | Suggest types for each any |
| `--baseline` | Save current as baseline |
| `--history` | Show trend vs baseline |
| `--ignore <pattern>` | Ignore files matching pattern |

## Install
```bash
npx type-coverage
npm install -g type-coverage
```

---
**Zero dependencies** · **Node 18+** · Made by [NickCirv](https://github.com/NickCirv) · MIT

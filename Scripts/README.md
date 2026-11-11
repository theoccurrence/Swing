# The Scripts

Tooling for Swing. Pure Python 3 stdlib (plus
[capstone](https://pypi.org/project/capstone/) for the disassembler) — runs on
Windows, macOS, or Linux without needing Mac/Xcode.

## 🔍 Crash analysis — `Scripts/crash-analysis/`

`.github/workflows/crash-analysis.yml` downloads a built IPA artifact, extracts
the app binary + injected dylibs, and produces `crash-analysis-report/analysis_report.txt`
with a selector audit plus reference dumps in `refdata/`.

| Script | Purpose |
|---|---|
| `parse_ips.py` | Parse an Apple `.ips` crash report: real exception reason, image table, backtrace with function-boundary mapping |
| `local_symbolicate.py` | Map `.ips` imageOffset values to function starts using `refdata/` |
| `local_hook_audit.py` | Diff every tweak dylib's defined selectors against YouTube's implemented set (uses `refdata/`) |
| `crash_analyzer.py` | Mach-O parser: `info`, `selectors`, `syms`, `funcstarts`, `symbolicate <dylib> <offsets>`, `audit <ytbin> <dylib>` |
| `disasm_find_sel.py` | Disassemble a function (capstone) and resolve `__objc_selrefs` references |
| `resolve_selref.py` | Decode chained-fixup selector slots into selector strings |
| `hunt_cstring.py` | Dump `__cstring` strings from a Mach-O matching a regex |

Each script keeps a `DYLIB_NAMES` list of the dylibs this pipeline can inject; add
new tweaks there so they show up in the audits.

## Typical crash debugging flow

1. Crash happens → pull the `.ips` from the device
   (Settings → Privacy & Security → Analytics → Analytics Data)
2. `python Scripts/crash-analysis/parse_ips.py YouTube-<date>.ips`
   → shows the true backtrace; note any frame inside one of the injected dylibs
3. Download that build's IPA, extract the named `.dylib` into the repo root
4. `python Scripts/crash-analysis/disasm_find_sel.py <dylib> 0x<start> 0x<end>`
   around the crashing offset, then
   `python Scripts/crash-analysis/resolve_selref.py <dylib> 0x<selref...>`
   → prints the exact missing selector
5. Report it in the offending tweak's own repository — this repo only injects
   third-party tweaks, it does not patch them.

`refdata/` is produced by the CI workflow; refresh it after each new build so
offsets stay accurate.

## Notes

- `__pycache__/` is local-only — don't commit it.

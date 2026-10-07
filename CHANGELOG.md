# Changelog

## 1.0.0 - 2026-10-07

First version.

- Code layout: a blank line after a block (unless the enclosing block ends) and before loops, conditions and try (unless the block starts there), in the generated code and in the sources.
- `.editorconfig` for Visual Studio (C# 5 style, no warnings).
- Guided console: profiles (MII server or export folder, working directory, optional DPAPI-protected password),
  connection check with hints, recent transactions, "did you mean" for unknown paths.
- One-shot mode for scripts (`--profile`, `--folder`, `--trx`, `--out`, `--all`).
- Recursive resolution of transaction calls, query templates (SQL, MDO, XML, Xacute) and the transactions behind
  Xacute queries.
- C# 5 output: one static class per transaction with Request/Response, query classes with typed parameters, typed
  rowset contracts, control flow, links, MII expressions, `IQueryService`/`IPluginService` and the `Mii` helpers.
- Tests (27) and `tools/corpus-check.ps1`; all 526 transactions of the BLS corpus give compiling C#.

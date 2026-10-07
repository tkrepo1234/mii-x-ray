# Changelog

## 1.1.0 - 2026-10-07

For the analysis with an LLM (Copilot) and closer to how one writes C#:

- Header: reading rules, call tree in execution order with its flow context ([if X], [else X], [loop X],
  [on error X]) and a query overview (parameters, the actions that run it, columns read and not read by name).
- Default documents keep two elements of each repeated name plus a comment with the number left out (test data no
  longer fills the file); XSLT stays as it is.
- Action results are declared where they come into being; only values read outside their block stay at the top.
  A Catch result is the catch clause's variable.
- MII idioms by name: the empty check `(?i)^\s*(null|---)?\s*$` is `Mii.IsEmpty(x)`, the boolean check
  `(?i)^\s*(true|1)\s*$` is `Mii.IsTrue(x)`, `number("0" & n)` of a whole number is `n`.
- Tests: 32.

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

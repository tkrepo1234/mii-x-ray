# Changelog

## 2.1.2 - 2026-10-08

- A local the flow only edits at an XPath (set a value, append, remove) keeps its MII value: request templates and
  XSLTs whose `xsl:param`s the flow sets were shown as `new()`, so their content was missing. Only a write that
  replaces the whole local (Assign / AssignXml / ReplaceXml without XPath) empties it, as before. Corpus: 42 locals in
  39 of 526 transactions now show their template; everything else is unchanged.

## 2.1.1 - 2026-10-07

- The web page reads only the MII server it comes from; the export folder source is test-only
  (`web/test/folder-source.js`) and no longer part of the page.
- Layout: hidden rows stay hidden, the code view no longer widens the page.

## 2.1.0 - 2026-10-07

- MII X-Ray as a web page for the MII server (`web/dist/mii-x-ray.html`, one self-contained file): reads through the
  Catalog service with the signed-in session or from an export folder chosen in the browser; copy and download of
  the result, recent transactions, "did you mean" for unknown paths.
- The JavaScript version is the leading one from now on. Proven against the C# console: 526 of 526 corpus
  transactions give byte-identical output (`web/test/equivalence.mjs`); in the browser against the MUD mock catalog
  the result equals the console's for the same transaction.
- Plain ES modules without dependencies, an own XML parser, `web/build.mjs` bundles everything into the page.

## 2.0.0 - 2026-10-07

The generated code is C# 12 (.NET 8) and written the way one writes C#; the tool itself stays C# 5 / .NET 4.8.
The classic C# 5 output is the git tag v1.1.0.

- One class with one method per transaction (services through the primary constructor) instead of a static class
  with Request/Response/Execute per transaction. Inputs are optional method parameters, outputs the return value
  (a record when there are several); calls use named arguments.
- Queries are local `Query` variables with `AddParameter(name, value)` and a comment mapping `[Param.N]` to the names
  instead of query classes; `queries.Execute<Row>(query)`.
- Rowsets are `List<Row>` of row records; `FirstOrEmpty()`, `RowAt(n)`, `FirstOrEmpty(row => ...)`, `Count`.
- No MII default values and no reference documents; a local the flow never writes keeps its value (XSLT, options).
- String interpolation, raw string literals for SQL and XML, verbatim literals for regular expressions, `var`.
- Plugin calls with a dictionary initializer (`new() { ["Setting"] = value }`).
- Parser: `x and (y)` is the operator, not a call of the function `and`.
- Corpus check and the end-to-end test compile as C# 12 against .NET 8; the end-to-end test runs the result.

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

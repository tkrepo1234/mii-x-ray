# Changelog

## 2.6.0 - 2026-10-28

Simulation mode (Tim: "Du musst nur TRX-Eigenschaften mit emulieren"): the X-Ray runs the way MII runs the
transactions, so today's objects and a rebuild can be run side by side on the same scenarios.

- `tools/sim-convert` turns a default-mode file (2.5 or later) into the simulation mode: Roslyn from the .NET SDK reads
  the generated C# and its comments (attributes, MII names and defaults, action settings, the query overview) and
  wraps links, calls and reads; `SimulationRuntime.txt` replaces the services region and adds the region
  "MII simulation". Generating in simulation mode is the same step (`web/test/simulation.mjs`), so a file X-rayed on
  MII and one generated locally give the same code. The page has no switch; the default output is unchanged.
- Hooks: `MiiSim.Run(logic, path, inputs)` with inputs and outputs as MII text; `IQueryService.Execute(SimQuery)` with
  template, mode, typed flag, RowCount, the slots and the statement as MII sends it (typed slots as `?` with their
  values); `IPluginService.Invoke` with every configured setting and the linked values; `IPluginService.CallExternal`
  for transactions outside the file and those `MiiSim.ExternalPaths` names; `MiiSim.Diagnostics` for errors MII swallows.
- Emulated: ThrowOnLinkError 0/1 and ThrowOnActionError 0/1; "Invalid variable" for a link to an output of an action
  that has not run; ResetState false/true (the callee keeps inputs, locals, outputs and action results of the previous
  call of the same call action in the caller's run); callee defaults for unlinked inputs, Runner defaults, local and
  output defaults; the template's Param.N for unset query parameters; MII text and types at the boundaries (number
  input `abc` = 0, query nulls `---`/`NA`, trailing blanks cut, RowCount); Catch, Throw, Terminate as before.
- `web/test/simrun.mjs` runs small transactions on .NET and checks each rule; `web/test/corpus.mjs --simulation`
  converts and compiles the corpus. `C:\Claude\pp\tools\xray.mjs` got `--simulation`.

Assumed (not documented or not verified on MII; the simulation follows the guide's verified behaviour where there is
one):

- A transaction without ThrowOnLinkError / ThrowOnActionError counts as 1.
- ResetState: the configured value of the call action decides. The default-mode file only marks a ResetState link
  ("linked"), not its value; a literal link that differs from the configuration (verified to win, C1) is not seen. No
  value: false.
- ThrowOnLinkError 0 is exact for links that are single statements or values: outgoing links and Assignment links,
  call inputs, query parameters, plugin settings, Tracer messages. A failing reference inside a condition, a loop
  source, an XSLT or Throw/Terminate input still raises the exception; inside a call statement it skips the action.
- ThrowOnActionError 0: the failed action counts as run and its outgoing links run (MII's link evaluation order; not
  documented). `Success` / `LastErrorMessage` read by links keep the design-time values the default file shows.
- A link of text that is no number (also `""`) into a number, or of no date into a dateTime, fails with "Conversion
  Exception" (verified only for `""` into an integer call input); `MiiSim.StrictLinkConversions = false` switches it off.
- Booleans from text are true for `true`, `1`, `yes` (verified V2); other text and `""` are false.
- An unset text `[Param.N]` without a saved `Param.N` becomes empty text; a typed one null. A typed `[Param.N]` in
  quotes stays literal text (as the X-Ray notes say). Typed Integer slots refuse text that is no number before the
  query runs; Timestamp is read without the template's DateFormat. The saved `Param.N` comes from the header overview,
  which shows multi-line values on one line.
- Xacute query calls pass every input: unmapped ones and mapped ones the action does not set arrive empty (the
  template's `Param.N` for a mapped unsent slot is not applied).
- Asynchronous calls run in line; their failure does not reach the caller.
- Columns a query returns that the row record does not know are dropped (the record holds the columns the X-Ray
  found in the statement and in the last test run).
- A loop's Break set inside a callee is not kept across calls with ResetState false.

## 2.5.1 - 2026-10-28

- The query overview leaves out the template setting `TempTableList` (the table list the query editor offered, not a
  setting of the query).

## 2.5.0 - 2026-10-28

Tim: no export of MII objects; what a rebuild needs goes into the `.xray.cs`.

- The **Raw ZIP** of 2.3.0 is gone again (button, ZIP writer, test).
- Declarations: MII type and the **full MII default value** next to the exact name (`// Transaction.Site (string),
  default: M`; multi-line values such as XML documents on comment lines above). The code still starts from empty
  values; a local the code already initializes with its full value shows no second copy.
- **MII settings** of every action (except assignments, conditions, loops and catches): each configured property as
  MII stores it, linked ones marked, empty ones in one line, passwords as `***`, caches of the last test run left out.
- Each method lists the **transaction attributes** (ThrowOnActionError, FormatXMLOnConversion, ...); the query
  overview the **template settings** (Mode, Server, DateFormat, ...) and **parameter defaults**.
- **Web files** the transactions name (XSLT, XmlLoader source, XSD, XML query URL) are loaded from the server and
  stand as constants in `MiiFiles`; an XSL transformation with a known stylesheet uses the constant instead of
  `plugins.LoadResource(...)`.
- **Shared properties** the transactions use (`Inline.X`, `Persistent.X`): definition and default value from
  `SharedProperties.mem` in the header.
- `web/test/staticfiles.mjs` checks web files and shared properties with a fixture.

## 2.4.0 - 2026-10-28

- **Exact MII names** at every declaration, as MII spells them: `// Transaction.X` at each input (one parameter per
  line) and output (also in the result record), `// Local.X`, `// action X` for an action result, `// column X` at
  each row property. The C# names (camelCase, PascalCase) lose the case; a rebuild needs the MII spelling.
- **Typed parameters**: a SQL or MDO template with Use Typed Parameters sets its values with
  `AddTypedParameter(name, type, value)` (bound as statement parameters), one without keeps `AddParameter` (replaced
  as text). The comment above the call and the query overview name the mode and the `ParamType.N` of each slot; a
  quoted `'[Param.N]'` in a typed template is a note. The reading rule no longer says that every parameter is text.

## 2.3.0 - 2026-10-28

- **Raw ZIP** next to the C# file (`<Name>.xray.zip`): the loaded transactions and query templates exactly as the
  Catalog returned them (exact names, default values, XML documents, all action and template settings), the web
  files they name (XSLT, XML, XSD) under `<Project>/WEB/`, `META-INF/SharedProperties.mem` per project and, where the
  server answers `GetRuntimePropertyList`, the running values. `xray-manifest.txt` lists what is missing. Stored ZIP
  written by the page itself, no library.
- `web/test/rawzip.mjs`: X-Rays folders, unpacks the ZIP with tar and compares every entry; a fixture checks a
  stylesheet named by a link and by `/XMII/CM/...`.

## 2.2.1 - 2026-10-28

- Transactions load in batches (Catalog `LoadMultipleObjects`); a batch with a missing object is halved until the
  missing one is alone.

## 2.2.0 - 2026-10-28

The web page (leading version) X-Rays whole folders and follows the verified runtime behaviour of the SAP
Manufacturing Suite Definitive Guide and of the recent projects. The C# console keeps its 2.1 output; it shares the
runtime and was only aligned so its files still compile (`currenttimezoneoffset`).

Folders:

- A folder path X-Rays everything below it into one file (`<Folder>.xray.cs`): one public method per transaction,
  the transactions they call outside the folder as private methods, query templates no transaction runs as public
  methods, a call tree per entry point. The page stays as it was; it recognises a folder by the Catalog's
  `Exists` answer 2 and lists it with `LoadFilesInsideFolderAndSubfolders`.
- `web/test/corpus.mjs`: every transaction and every folder of an export X-rayed and compiled as C# 12.

Fixes, where the C# showed something other than what MII does:

- `&&`, `||`, `and()`, `or()` and the inputs of a Conditional evaluate every part: C# `&` / `|` instead of the
  short-circuit operators, which suggested a guard that MII does not have.
- `if()` with a text branch returns a number in MII (0, or a type cast error in a string function): `Mii.If` and a
  note instead of a C# conditional on strings.
- `number()` fails on empty and other text (`Mii.Number`); a missing map key reads as the text `null`;
  `Map{"Key"}` with quotes is the key; `list(list, x)` adds the elements of a list argument; `first()`/`last()` of an
  empty list fail; `liststomap` sorts its keys; `remove(map, key)` removes the key; `stringreplaceall` drops the
  blanks of its replacement; `encode`/`decode` are form encoding; `random(low, high)` keeps its bounds;
  `datefromxmlformat(date, format)` returns text; `currenttimezoneoffset` is a number of milliseconds and
  `currenttimeoffset`, which MII does not know, is a note.
- A string literal with an escape other than `\\`, `\"`, `\r`, `\n`, `\t` is a note (it does not compile in MII).
- An Iterator over a map goes through its keys; `<Iterator>.Item` does not exist in MII (note).
- Assign XML at an XPath fills the selected node with the source's children and text instead of replacing the node;
  Assign XML of a text into an XML target has no effect in MII (comment and note instead of an assignment).
- A Transaction Call whose `TransactionName` is set by an expression is a call chosen at runtime (plugin call and
  note) instead of a call of the configured interface transaction; a literal link wins over the configured name.
- A query's `RowCount` (linked, configured on the action or in the template) becomes `Query.RowCount`: MII drops
  further rows without a message.
- Only the first child of a Catch is its handler.
- Marked: calls inside loops with ResetState false (the callee keeps its state), asynchronous calls (also when Async is
  linked), transactions with ThrowOnLinkError off, links into a Conditional other than its inputs.

New MII functions: `year`, `month`, `day`, `hour`, `minute`, `second`, `dayofweek`, `dayofyear`, `daysinmonth`,
`monthstart`, `monthend`, `yearstart`, `yearend`, `datetoxmlformat`, `getsessionvariable`, `exp`, `ln`, `log`,
`logn` and the trigonometric functions.

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

# MII X-Ray

Turns an SAP MII transaction into one C# file: the transaction itself and, resolved recursively, every
transaction and query template it uses. The file shows **what the logic does** (loops, decisions, exceptions,
queries with their parameters, inputs and outputs), written the way one would write it in C#, not a copy of the MII
runtime. Typical use: hand the file to an LLM or a colleague to understand, review or port a transaction.

- The **tool** is C# 5 / .NET Framework 4.8 without packages: one `MiiXRay.exe`, copy it anywhere (xcopy
  deployment). Profiles live in `%APPDATA%\MiiXRay\profiles.xml`.
- The **generated code** is C# 12 (.NET 8): methods, records, LINQ, string interpolation, raw string literals.
  The classic C# 5 output of version 1.x is available as the git tag `v1.1.0`.

## Web tool (leading version)

`web/dist/mii-x-ray.html` is MII X-Ray as one self-contained web page for the MII server itself. Since 2.1.0 the
JavaScript version under `web/` is the leading one; the C# console stays at the 2.1 output (it was the reference the
port was proven against: 526 of 526 corpus transactions gave byte-identical files) and only shares the runtime.
Since 2.2.0 the page follows the SAP Manufacturing Suite Definitive Guide's verified runtime behaviour (see
CHANGELOG), which the console does not.

**Transaction or folder.** Enter a transaction (`PROJECT/Folder/trxName`) or a folder (`PROJECT/Folder`). A folder
gives one file with everything below it, subfolders included: one public method per transaction of the folder, the
transactions they call outside the folder as private methods, query templates no transaction runs as public methods,
and a call tree per entry point.

**Everything a rebuild needs is in the one file** (no export of MII objects): every declaration carries the exact MII
name and type as a comment (`// Transaction.Site (string)`), the MII default value is set in the code as MII sets it
(`string site = "M"`, XML in full; a default larger than 128 KB stands as `[n-bytes]`, see Limits); every action
lists its configured settings (`// MII settings (Type):`, linked ones marked, caches of the last test run left out);
each method shows the transaction attributes, each query the template settings and parameter defaults. Web files the
transactions name (stylesheet of an XSL transformation, document of an XML loader, schema of an XSD validation, URL
of an XML query: `db://P/WEB/...`, `/XMII/CM/P/...`) are loaded from the server and stand as text constants in the
class `MiiFiles`; the shared properties the transactions use (`Inline.X`, `Persistent.X`) are listed in the header
with their definition and default value from `<Project>/META-INF/SharedProperties.mem`.

Deploy: in the MII Workbench, open the **Web** tab of a project, import `mii-x-ray.html` into a folder and open
`https://<mii-server>/XMII/CM/<Project>/<Folder>/mii-x-ray.html`. The page reads transactions through the Catalog
service with the signed-in user's session (the user needs access to the Catalog service, e.g. SAP_XMII_Developer);
nothing is installed and no password is stored. Transactions are loaded in batches (LoadMultipleObjects,
which MII supports only for Class=Transaction); query templates one by one. The page only reads the MII server it comes from; opened as a local
file it does nothing. The last transactions are kept in the browser (local storage).

```
node web/build.mjs                                   builds web/dist/mii-x-ray.html from web/src (minified by web/minify.mjs)
node web/test/corpus.mjs <export folder> <work folder>  every transaction and every folder X-rayed and compiled as C# 12
node web/test/equivalence.mjs <export folder> <C# output of --all>    JS against the C# console (2.1.x only)
node web/test/staticfiles.mjs <export folder> <work folder>        web files and shared properties in the file
node web/test/minified.mjs <export folder> <work folder>         the minified page generates the same files
node web/test/defaults.mjs <work folder>                           MII defaults in the code, [n-bytes] above 128 KB (runs on .NET)
node web/test/serve.mjs 5300 http://localhost:50100 dev:dev           the page at /XMII/CM/XRay/ with a Catalog proxy

web/test/folder-source.js reads an export folder; it serves the tests only and is not part of the page.
```

The sources in `web/src` are plain ES modules without dependencies (own XML parser, so the browser, Node and the
.NET reference behave alike); `build.mjs` puts them, the stylesheet and the C# runtime (`src/Generate/RuntimeSource.txt`,
the one source of it) into the single page. Not yet tried on a real MII server: whether it asks for a CSRF token on
Catalog POSTs (the page fetches one when the server answers 403 with `X-CSRF-Token: Required`).

## Simulation mode (2.6.0)

The default file shows what the logic does; the **simulation mode** runs it the way MII runs it, to prove by
simulation what otherwise only an MII run proves (e.g. that a rebuilt package leaves the same footprint as today's
objects). It is made from a default-mode file by `tools/sim-convert` (Roslyn of the .NET SDK, no packages), so a file
X-rayed on the MII server with the page and one generated here give the same simulation code:

```
node web/test/simulation.mjs <in.xray.cs> <out.sim.cs>           convert a default-mode file (2.5 or later)
node web/test/corpus.mjs <export folder> <work folder> --simulation  every corpus file converted and compiled
node web/test/simrun.mjs <work folder>                             runs small transactions on .NET, checks each rule
```

The page has no simulation switch: X-Ray on MII as usual (default mode), convert the `.xray.cs` locally.

Run a transaction by its MII path with inputs and outputs as MII text:

```csharp
var simulation = new MiiSim(queries, plugins);             // IQueryService, IPluginService (simulation versions)
simulation.ExternalPaths.Add("BB_BUILDINGBLOCK/");          // optional: run these through plugins.CallExternal
var outputs = MiiSim.Run(new ProductionProcessLogic(simulation), "ME/ProductionProcess/trxPhaseProductive", inputs);
```

Hooks: `IQueryService.Execute(SimQuery)` gets template path, kind, mode, typed flag, RowCount, every slot (name, slot,
type, set or default, text, value) and the statement as MII sends it (text parameters replaced, typed ones as `?` with
`Values` in order); it returns every result set (`SimQueryResult.Rowsets`: columns with database type, rows as column name to text, null for a database null). `IPluginService.Invoke` gets
every configured setting of the action with the linked values put in (`Request`: the request document);
`IPluginService.CallExternal(path, inputs)` runs transactions that are not in the file (and those `ExternalPaths`
names). `MiiSim.Diagnostics` lists the errors MII swallows.

What the simulation emulates (CHANGELOG 2.6.0 lists what is assumed):

- `ThrowOnLinkError` 1: a failing link raises the exception; 0: the link leaves its target unchanged, the run goes on.
  A failing link into a call input leaves the input unlinked (callee default). `ThrowOnActionError` likewise.
- A link to an output of an action that has not run fails with "Invalid variable".
- `ResetState` false: the call action keeps the callee's inputs, locals, outputs and action results of its previous
  call in the same run of the caller; true: each call starts from the defaults.
- Defaults: an input the caller does not link gets the callee's default (not the stored snapshot); Runner inputs not
  given get their default; locals and outputs start with their defaults; an unset query parameter takes the
  template's `Param.N`, an unset slot without one is empty text.
- Values cross the boundaries as MII text and MII types: a number input given `abc` arrives as 0, a link of text that
  is no number into a number fails ("Conversion Exception", switch: `MiiSim.StrictLinkConversions`), query nulls are
  `---` / `NA`, trailing blanks of text columns are cut, RowCount cuts the rows.
- Catch, Throw and Terminate as in the default runtime.

## Build (console)

```
build.cmd          bin\MiiXRay.exe, built with the C# compiler that ships with Windows (.NET Framework 4.x)
build.cmd test     also builds and runs the tests (bin\MiiXRay.Tests.exe)
```

`MiiXRay.sln` (with `MiiXRay.csproj` and `tests\MiiXRay.Tests.csproj`) builds the same in Visual Studio 2017 or later
or with `dotnet build`. Both builds pin `LangVersion 5` for the tool, so no newer C# feature can creep in; the
`.editorconfig` keeps Visual Studio on that style.

## Use

Start `MiiXRay.exe` without arguments. The guided console asks, step by step:

1. **Profile**: choose one or create one: an *MII server* (host, http/https, port, user, password optional and
   encrypted for your Windows user with DPAPI) or a *local export folder* (an unpacked project export), and the
   **working directory** for the generated files. Profiles can be edited and deleted from the same menu.
2. **Connection**: checked right away; a problem comes with what to do about it (wrong password, missing role,
   wrong port, untrusted certificate, VPN, ...), and you can retry, re-enter the password or edit the profile.
3. **Transaction**: type the path as in the Workbench (`PROJECT/Folder/trxName`, with or without `.trx`) or a
   number from the list of recent transactions. A path that does not exist shows similar objects.

The result is `<working directory>\<TrxName>.xray.cs`.

For scripts:

```
MiiXRay.exe --profile DEV --trx PROJECT/Folder/trxName [--out C:\temp]
MiiXRay.exe --folder C:\exports\PROJECT --trx PROJECT/Folder/trxName
MiiXRay.exe --folder C:\exports\PROJECT --all --out C:\temp\xray      every transaction of an export
```

A server profile without saved password reads it from the environment variable `MIIXRAY_PASSWORD`.

## What the generated file contains

| MII | C# |
|---|---|
| the transactions | one class `TrxNameLogic(IQueryService queries, IPluginService plugins)` with one method per transaction; the root is public, the transactions it calls are private |
| inputs / outputs | optional method parameters with the MII default (XML, list, map and date inputs: set in the first lines of the method) / the return value: the only output, or a record `TrxNameResult(...)`; outputs start with their default |
| transaction call, dynamic call with a literal name | `var result = TrxCallee(input: value, ...)` with named arguments |
| local variable | local variable that starts with its MII default; one the flow replaces as a whole before reading it is declared where it is set (the comment then gives the default) |
| SQL / MDO query template | a local `var sqlName = new Query("""...""")`, `sqlName.AddParameter("Site", value)` and `queries.Execute<SqlNameRow>(sqlName)`; a comment maps `[Param.N]` to the names, the text stays as in MII |
| Xacute query | a call of the transaction it wraps (`Param.N` -> mapped input, `Results` -> selected output) |
| rowset XML (`Rowsets/Rowset/Row`) | `List<XRow>` of row records; columns from reference documents, the cached results of query actions (with SQL types), the SQL select list and every column the transactions read |
| `Doc{/Rowsets/Rowset/Row/Col}`, `Row[n]`, `Row[Col='v']`, `count(...)` | `doc.FirstOrEmpty().Col`, `doc.RowAt(n).Col`, `doc.FirstOrEmpty(row => row.Col == "v").Col`, `doc.Count`; any other XPath through `Mii.XPath` |
| Conditional / Switch | `if` / `else`, `if` / `else if` |
| Repeater / Iterator / For loop | `foreach (var ...)` over rows, nodes or a list / `for`; `Break` becomes a flag |
| Catch | `try` / `catch (Exception catchName)` around everything that runs before it in the same parent |
| Throw / Terminate Transaction | `throw new MiiException(...)` / `throw new TransactionTerminatedException(...)` or `return ...;` |
| Tracer, Event Logger | `plugins.Log(level, message)` |
| every other action (ME PAPI, web service, HTTP, mail, files, sort/filter, ...) | `plugins.Invoke("ActionClass", "ActionName", new() { ["Setting"] = value, ... })` |
| shared / global properties (`Inline.X`, `Global.X`) | `plugins.GetProperty` / `SetProperty` |
| expressions | C# with native operators and string interpolation where the types are known; MII functions as `Mii.*` helpers; the empty and boolean checks as `Mii.IsEmpty(x)` / `Mii.IsTrue(x)` |

The header is written for a reader without MII at hand (a colleague or an LLM): how to read the file, the call tree
in execution order with the condition, loop or error handler each call runs in, and per query its parameters, the
actions that run it and the result columns read by name. Values are declared where they come into being.

MII runtime settings (Persist, ResetState, logging, transaction attributes, layout) stand as comments at the actions;
cached test results are left out. The file ends with the service interfaces (`IQueryService`, `IPluginService`) and the `Mii`
helper class, so each file compiles on its own.

MII rules the helpers keep: booleans are true for `true` or `1`; `match()` is case-sensitive unless the pattern
starts with `(?i)`; `datediff()` returns seconds; `stringpart()` counts from 1; `append()` changes the list it gets;
`==` binds weaker than `&&` and `&` binds tighter than comparisons (SAP's operator precedence).

Since 2.2.0 also (verified behaviour from the Definitive Guide and Tim's projects): `&&`, `||` and the inputs of a
Conditional evaluate every part (C# `&` / `|`); `if()` returns a number, also for text branches (`Mii.If`, with a
note); `number("")` and `number` of other text fail (`Mii.Number`); a missing map key reads as the text `null`;
`list(list, x)` adds the elements of a list argument; `first()`/`last()` of an empty list fail; `liststomap` sorts its
keys; `stringreplaceall` drops the blanks of its replacement; `encode`/`decode` are form encoding;
`currenttimezoneoffset` is in milliseconds; an Iterator over a map gives its keys and has no `Item`; Assign XML at an
XPath fills the selected node with the source's content; Assign XML of a text has no effect; a query's `RowCount`
becomes `Query.RowCount`; a `TransactionName` set by an expression is a call chosen at runtime; only the first child
of a Catch is its handler. Calls inside loops with ResetState false, asynchronous calls and transactions with
ThrowOnLinkError off are marked.

## Limits

- **A faulty transaction gives faulty C#, as is.** Links to inputs or actions that no longer exist, references to
  undeclared properties and the like are kept and listed under *Notes* in the file header; X-Ray does not repair.
- A default value larger than 128 KB (UTF-8 bytes) is not in the file: a text gets the text `"[n-bytes]"`, any other
  type starts empty and the comment says `default: [n-bytes]` (n = the size). Shared property and query parameter
  defaults in the header likewise.
- Over Xacute or the Runner an input that is not passed is empty in MII; C# gives it the parameter default (the
  simulation mode tells the two apart).
- `#expr#` (an expression built at runtime) and `getvalue(name)` cannot be translated; they become `Mii.Evaluate`
  and `Mii.GetValue` and are listed in the notes.
- A Catch handles what precedes it **in its parent** (a lexical `try`). In MII it also catches exceptions from
  earlier sibling branches of an ancestor; such rare layouts differ.
- Only rowset XML is typed; other XML documents (PAPI requests, web service payloads) stay `XmlDocument`.
- Java date patterns, Java regular expressions and Java time zone ids are mapped to .NET as far as they match
  (.NET `\w` and `\d` also match non-ASCII letters and digits, Java's do not).
- A call with ResetState false keeps the callee's state between calls in MII; the C# marks such calls in loops but
  runs each call fresh (the simulation mode keeps it). An asynchronous call is marked, the C# still runs it in line.

## Development

```
src/Model        the MII export formats (.trx, .tqsq, .tqmd, .tqxm, .tqxc)
src/Sources      MII server (Catalog service) and export folder
src/Resolve      loads the transaction and follows every static transaction and query reference
src/Expressions  lexer and parser of the MII expression language
src/Generate     contracts (methods, records, rows), expression translation, the step/action/link emitter, the file
src/Profiles     profiles and the DPAPI-protected password
src/Cli          guided console and the one-shot run
tests            test runner without packages, unit tests and an end-to-end test that compiles a result as C# 12
                 and runs it on .NET 8 (needs a .NET SDK with the .NET 8 reference pack, else it is skipped)
tools            corpus-check.ps1: X-Ray every transaction of an export folder and compile each file as C# 12
tools/sim-convert  default mode -> simulation mode (C# 12, Roslyn from the SDK) and the simulation runtime
                 (SimulationRuntime.txt: the services region it replaces and the region "MII simulation")
```

`tools\corpus-check.ps1 -ExportFolder <folder>` is the regression check: every generated file must compile (Roslyn
of an installed .NET SDK, .NET 8 reference assemblies). On the BLS corpus (526 transactions) all 526 compile.

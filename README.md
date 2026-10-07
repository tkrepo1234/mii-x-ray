# MII X-Ray

Turns an SAP MII transaction into one C# file: the transaction itself and, resolved recursively, every
transaction and query template it uses. The file shows **what the logic does** (loops, decisions, exceptions,
queries with their parameters, inputs and outputs), written the way one would write it in C#, not a copy of the MII
runtime. Typical use: hand the file to an LLM or a colleague to understand, review or port a transaction.

- The **tool** is C# 5 / .NET Framework 4.8 without packages: one `MiiXRay.exe`, copy it anywhere (xcopy
  deployment). Profiles live in `%APPDATA%\MiiXRay\profiles.xml`.
- The **generated code** is C# 12 (.NET 8): methods, records, LINQ, string interpolation, raw string literals.
  The classic C# 5 output of version 1.x is available as the git tag `v1.1.0`.

## Build

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
| inputs / outputs | method parameters (optional, without MII defaults) / the return value: the only output, or a record `TrxNameResult(...)` |
| transaction call, dynamic call with a literal name | `var result = TrxCallee(input: value, ...)` with named arguments |
| local variable | local variable; a local the flow never writes keeps its MII value (an XSLT, a map of options) |
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
actions that run it and the result columns read by name. Default documents show their structure (two elements of
each repeated name). Values are declared where they come into being.

MII runtime settings (Persist, ResetState, logging, transaction attributes, layout, cached test results) and default
values are left out. The file ends with the service interfaces (`IQueryService`, `IPluginService`) and the `Mii`
helper class, so each file compiles on its own.

MII rules the helpers keep: booleans are true for `true` or `1`; `match()` is case-sensitive unless the pattern
starts with `(?i)`; `datediff()` returns seconds; `stringpart()` counts from 1; `append()` changes the list it gets;
`==` binds weaker than `&&` and `&` binds tighter than comparisons (SAP's operator precedence).

## Limits

- **A faulty transaction gives faulty C#, as is.** Links to inputs or actions that no longer exist, references to
  undeclared properties and the like are kept and listed under *Notes* in the file header; X-Ray does not repair.
- Inputs a caller does not link stay empty (`null`); in MII they would get the callee's default value.
- `#expr#` (an expression built at runtime) and `getvalue(name)` cannot be translated; they become `Mii.Evaluate`
  and `Mii.GetValue` and are listed in the notes.
- A Catch handles what precedes it **in its parent** (a lexical `try`). In MII it also catches exceptions from
  earlier sibling branches of an ancestor; such rare layouts differ.
- Only rowset XML is typed; other XML documents (PAPI requests, web service payloads) stay `XmlDocument`.
- Java date patterns, Java regular expressions and Java time zone ids are mapped to .NET as far as they match.

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
```

`tools\corpus-check.ps1 -ExportFolder <folder>` is the regression check: every generated file must compile (Roslyn
of an installed .NET SDK, .NET 8 reference assemblies). On the BLS corpus (526 transactions) all 526 compile.

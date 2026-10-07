# MII X-Ray

Turns an SAP MII transaction into one plain C# file: the transaction itself and, resolved recursively, every
transaction and query template it uses. The file shows **what the logic does** (loops, decisions, exceptions,
queries with their parameter mappings, inputs and outputs), written the way one would write it in C#, not a copy of
the MII runtime. Typical use: hand the file to an LLM or a colleague to understand, review or port a transaction.

- C# 5 / .NET Framework 4.8, no packages. The tool and the generated code use only constructs that were valid
  in 2012 and still are.
- One `MiiXRay.exe`, copy it anywhere (xcopy deployment). Profiles live in `%APPDATA%\MiiXRay\profiles.xml`.

## Build

```
build.cmd          bin\MiiXRay.exe, built with the C# compiler that ships with Windows (.NET Framework 4.x)
build.cmd test     also builds and runs the tests (bin\MiiXRay.Tests.exe)
```

`MiiXRay.sln` (with `MiiXRay.csproj` and `tests\MiiXRay.Tests.csproj`) builds the same in Visual Studio 2017 or later
or with `dotnet build`. Both builds pin `LangVersion 5`, so no newer C# feature can creep in.

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
| transaction | `public static class TrxName` with `Request` (inputs, MII defaults), `Response` (outputs) and `Execute(request, queryService, pluginService)` |
| transaction call, dynamic call with a literal name | `TrxCallee.Execute(calleeRequest, ...)` - a static method call; unlinked inputs keep the callee's defaults |
| local variable | local variable |
| SQL / MDO query template | `queryService.ExecuteQuery<SqlName.Result>(SqlName.Text, new SqlName.Request(site: ...))`; `Text` is the statement, MII replaces `[Param.N]` textually |
| Xacute query | a call of the transaction it wraps (`Param.N` -> mapped input, `Results` -> selected output) |
| rowset XML (`Rowsets/Rowset/Row`) | typed `Row` / `Rowset` classes; columns from reference documents, the cached results of query actions (with SQL types), the SQL select list and every column the transactions read |
| `Doc{/Rowsets/Rowset/Row/Col}`, `Row[n]`, `Row[Col='v']`, `count(...)` | `doc.FirstRow.Col`, `doc.RowAt(n).Col`, `doc.FirstRowWhere("Col", "v").Col`, `doc.Rows.Count`; any other XPath through `Mii.XPath` |
| Conditional / Switch | `if` / `else`, `if` / `else if` |
| Repeater / Iterator / For loop | `foreach` over typed rows or nodes / `foreach` over a list / `for`; `Break` becomes a flag |
| Catch | `try` / `catch` around everything that runs before it in the same parent |
| Throw / Terminate Transaction | `throw new MiiException(...)` / `throw new TransactionTerminatedException(...)` or `return response;` |
| Tracer, Event Logger | `pluginService.Log(level, message)` |
| every other action (ME PAPI, web service, HTTP, mail, files, sort/filter, ...) | `pluginService.Invoke("ActionClass", request)` with the action's configuration and linked values |
| shared / global properties (`Inline.X`, `Global.X`) | `pluginService.GetProperty` / `SetProperty` |
| expressions | C# with native operators where the types are known; MII functions as `Mii.*` helpers |

MII runtime settings (Persist, ResetState, logging, transaction attributes, layout, cached test results) are left
out. The file ends with the service interfaces (`IQueryService`, `IPluginService`) and the `Mii` helper class, so
each file compiles on its own.

MII rules the helpers keep: booleans are true for `true` or `1`; `match()` is case-sensitive unless the pattern
starts with `(?i)`; `datediff()` returns seconds; `stringpart()` counts from 1; `append()` changes the list it gets;
`==` binds weaker than `&&` and `&` binds tighter than comparisons (SAP's operator precedence).

## Limits

- **A faulty transaction gives faulty C#, as is.** Links to inputs or actions that no longer exist, references to
  undeclared properties and the like are kept and listed under *Notes* in the file header; X-Ray does not repair.
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
src/Generate     contracts (classes, rowsets), expression translation, the step/action/link emitter, the file
src/Profiles     profiles and the DPAPI-protected password
src/Cli          guided console and the one-shot run
tests            test runner without packages, unit tests and an end-to-end test that compiles and runs a result
tools            corpus-check.ps1: X-Ray every transaction of an export folder and compile each file with C# 5
```

`tools\corpus-check.ps1 -ExportFolder <folder>` is the regression check: every generated file must compile. On the
BLS corpus (526 transactions) all 526 compile.

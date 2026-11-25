# Changelog

## 2.8.0 - 2026-11-25

Tim, 2026-11-25: X-Ray follows the newest findings of the SAP Manufacturing Suite Definitive Guide. The guide of
2026-11-23 settled the runtime behaviour of MII 15.5 SP1 and re-measured the open points on the real system (two test
runs of 2026-11-23). Where X-Ray said or did something else, it follows now. The measured points are marked (measured).

Flow of a transaction (generated code):

- **An exception that no Catch takes does not reach the caller** (measured). The transaction ends with status
  Terminated; for the caller that is a success: its call goes on with the outputs as they are, its Catch does not run.
  Only Terminate with error makes the call fail. The flow of a method that has an action no Catch follows stands in
  `try { ... } catch (Exception uncaught) when (!Mii.IsTerminationOf(...)) { }`, and the reading rules of the header
  say so. A transaction whose root ends with a Catch needs no such block (in the corpus that is nearly every one).
  Before, the C# exception ran into the caller's catch block.
- A Throw with `TerminateException` true is Terminate with error (no Catch takes it). The outgoing links of a Throw and
  of a Terminate run. `TerminateWithError` is true when the action does not set it.
- Catch: `ExceptionType` is `USER_EXCEPTION` (Throw), `ACTION_FAILURE` or `OUTPUT_LINK` (before: the .NET type name).
  Inside a loop the outputs of a Catch that is reached without an exception are empty again. Further children of a
  Catch run on every pass (the note said "not documented"). `Catch.Success` is true.
- A Conditional whose `LogicalAnd` is empty is OR (before: AND). A While loop without `MaxIterations` runs at most 256
  times (before: without limit). The `Break` of a loop inside a loop is declared once for the method: MII never resets
  it.
- `Action.Success` and `Action.LastErrorMessage` are `Mii.ActionSuccess("Action")` and `Mii.LastErrorMessage("Action")`
  (before: the value stored by the last test run in the Workbench).
- Remove XML without an XPath has no effect in MII: a comment and a note instead of emptying the document (in the
  corpus mostly `Transaction.Results` in error handlers, which therefore keeps its value).
- An XML input of a call that only element links fill starts from the callee's default (measured), not from an empty
  document.
- Xacute query: an input the query does not map keeps its default (measured, the README said "empty"); a mapped text
  input whose parameter the action does not set gets the parameter's value of the action or the template, also empty.
- A Tracer with outgoing links is marked: MII skips the Tracer and its links when the run's log level is above its
  level, and always in a transaction called with Persist NEVER (measured).
- A query template with RowCount 0 returns one row (`RowCount = 1`).
- The note for ThrowOnLinkError off says what MII does: no exception, but the list of links ends at the failing link,
  what it wrote before is taken back, and an action whose incoming link fails does not run.

Expressions (parser and translation):

- `&&` and `||` share one precedence level and are applied from left to right (`A || B && C` is `(A || B) && C`); `^`
  is left-associative (`2 ^ 3 ^ 2` is 64, before 512). `//` starts a comment. `\t`, `\n`, `\r` (and `\f`, `\b`, `\'`)
  in a literal are the control characters (measured for `\t` and `\n`; before the backslash stayed in the text).
- `match()` is `Mii.Match`: it ignores case (measured: `match("abc", "ABC")` is true), `(?-i)` makes it
  case-sensitive, a third argument changes nothing. Before: `Regex.IsMatch`, case-sensitive.
- `<` `>` `<=` `>=` compare numbers only: `Mii.ToNumber(a) < Mii.ToNumber(b)` where a side is no C# number. An empty
  side makes the comparison false, other text fails (before: a comparison as text).
- `+` follows MII's operand types: a text added to a whole number is cut to a whole number first (`"2.5" + 1` is 3),
  two texts add as integers. A value read through an XPath counts as text, whatever type its row record has.
- `&&` with a text on the left compares the two texts (`Mii.AndText`, with a note).
- `if()` evaluates only the branch it takes: `Mii.If(condition ? a : b)`.
- Notes for what does not compile in MII: a function MII does not have (`quotes`, `sum`, `and`, `or`, `name`, ...: the
  set of registered functions is in the translator), a function or keyword written in another case (`getvaluefrommap`
  for `getvaluefromMap`), `match2` without its third argument (measured), `round` with a second argument.
- Keywords: `nullstring` is the text `---` (before `""`); new `null`, `nanotime`, `settings`.
- A boolean literal as text is `"1"` or `"0"`. `stringtoboolean()` is `Mii.StringToBoolean` (true only for `true`).

Runtime (`Mii`, part of every file; a file converted to the simulation mode gets it whatever version wrote the file):

- Text forms: a boolean is `1` / `0` (before `true` / `false`); a double has no exponent and at most 12 decimals, `12.0`
  is `12`, not-a-number and the result of a division by zero are `NA` (`Mii.NumberText`); a list is
  `[[string:a], [string:b]]` and a map `{Key=[string:v]}`, both `""` when empty (before `a,b` and `{Key=v}`).
- `Mii.ToBool` reads text as MII does: `true/yes/on/1/y/t`, `false/no/off/0/n/f`, whole numbers (1 or more is true), a
  text with a decimal point is false, other text fails. `""` stays false (it stands for a boolean a service did not
  set; MII fails there).
- `Mii.AreEqual` converts the right side to the type of the left side: `5 == "5.0"` is true, `"5.0" == 5` false,
  `"true" == true` false; `==` never fails.
- `Mii.Number`: the leading number (measured: `"12abc"` 12, `"0abc"` 0, `"1,5"` 15, `"1e3"` 1, `" 5 "` 5, `""` fails).
  `Mii.Round`: a half goes up (`round(-2.5)` is -2), text that is no number fails (measured).
- Maps: `Map{Key}` of a missing key is `""`, `getvaluefromMap` the text `null` (both measured; before both `null`).
  `keys()`, `values()`, the text of a map and a loop over a map follow the hash order of a Java HashMap
  (`Mii.HashOrder`; measured: `Sfc`, `Site`, `Operation` come as `Site`, `Sfc`, `Operation`). `liststomap` does not sort
  (measured; 2.2.0 sorted), trims its keys and fails for lists of different length.
- `stringreplaceall` trims the replacement (measured: a blank inside stays, 2.2.0 removed every blank) and takes
  Java's replacement syntax (`$1`, `${name}`, `\$`). `stringtolist` and `stringtolistwithlimit` split as Java does: no
  groups in the result, empty parts at the end dropped, every part trimmed, `""` gives one empty part.
- `size()` of a text is 0 (a text in list or map notation counts as that collection). `append()` adds the elements
  of a list argument. `average()` divides by the number of arguments. `encode()` also encodes `! ( )`.
- Dates: a date text is read in the XML format only, what follows the seconds is ignored (before: an offset was
  applied); `dateformat()` of a text that does not fit its format gives `""`; `datetoseconds` and `datefromseconds`
  count from year 1 (62135769600 s before 1970) and use the instant; an unknown time zone id is GMT.
- XML links: Assign XML at an XPath replaces the selected element by the source element, the source's name wins
  (measured; 2.2.0 kept the target element and copied the content). An XPath that selects nothing fails with "No
  nodes found in xpath ..." (before: the path was created). Exception: a document that X-Ray starts empty is still
  built by plain element paths, so files of earlier versions keep working.
- New: `Mii.ToNumber`, `Mii.AndText`, `Mii.StringToBoolean`, `Mii.NumberText`, `Mii.HashOrder`, `Mii.NanoTime`,
  `Mii.ActionSuccess`, `Mii.LastErrorMessage`, `MiiException.ExceptionType`. `Mii.Compare` and the three-argument
  `Mii.If` stay for files of earlier versions.

Simulation mode (`tools/sim-convert`):

- A transaction whose exception no Catch takes ends Terminated (`frame.Uncaught`): the caller's call succeeds with the
  outputs as they are, `LastErrorMessage` holds the message (`TRANSACTION EXECUTED OK` after a normal end), an entry
  run returns its outputs (all measured). The converter adds the try block to files of earlier versions. A callee
  ended by Terminate with error fails the call action: `Catch.Source` is the call action, `ExceptionType`
  `ACTION_FAILURE`.
- `Action.Success` and `Action.LastErrorMessage` come from the frame.
- An Xacute query no longer empties the inputs it does not map: they keep their defaults (measured).
- Query results: a text value is trimmed on both sides (measured; before only at the end).
- `Regex.IsMatch(text, pattern)` of a file of an earlier version becomes `Mii.Match` (case-insensitive).
- Boolean values cross the boundaries as `1` / `0`; text to boolean reads `true/yes/on/y/t` and whole numbers from 1.

Tests: `web/test/simrun.mjs` has 46 more checks for the rules above (104 in all); the three checks that expected an
uncaught exception to fail the entry run expect the Terminated end now. Corpus 818 of 818 compile in the default and
in the simulation mode; 40 files written by 2.7.3 convert and compile with the new converter; the minified page
generates the same 818 files; `build.cmd test` 32 of 32. `web/dist/mii-x-ray.html`: 222 KB -> 251 KB (the runtime
text grew). The page itself (reading the Catalog, the user interface) is unchanged and was not opened in a browser
for this version.

Known differences that stay (README, Limits): the list rule of ThrowOnLinkError off, a loop that MII does not leave on
an exception, the outgoing links of a Catch, bounds errors of `stringpart`/`stringleft`/`stringright`, typed `sort()`,
the line breaks of `base64encode`, the `Expiration` of action properties, Tracer skipping (marked only).

What needs a new X-Ray on MII: everything under "Flow" and "Expressions" (the generated code changes). The runtime
changes reach a file of an earlier version when it is converted to the simulation mode.

## 2.7.3 - 2026-11-04

Tim, 2026-11-04: variable and function names minified as well.

- `web/minify.mjs` renames every name the code declares (variables, constants, functions, classes, parameters,
  also the module loader) to a short one, the same one everywhere. Without scope analysis that is safe because the
  renaming is one to one and the short names are names the code nowhere uses. Property names (`a.x`, object keys,
  methods, getters), shorthand names (`{ a }`, also a key), the globals of the browser and the engine and keywords
  stay. `web/dist/mii-x-ray.html`: 249 KB -> 222 KB (78 KB of it the C# runtime text). Properties with a leading
  underscore would give about 4 KB more and are left alone: renaming properties needs certainty that no code reaches
  them by a computed name.
- `web/test/minified.mjs` minifies the modules with renaming (the names a module exports or imports stay, in the page
  they are object keys): corpus 818 of 818 and Tim's ME_EI/XML_FILE_INTERFACE 146 of 146 files byte-identical. Edge
  headless against the MUD mock catalog: a transaction, a folder and a mistyped path (with the similar name offered),
  no console errors.

## 2.7.2 - 2026-11-04

Tim, 2026-11-04: the page for MII as small as its operation allows.

- `web/build.mjs` minifies the page with `web/minify.mjs` (own code, no dependencies): JavaScript without comments,
  indentation, blank lines and line breaks where automatic semicolon insertion cannot happen; strings, template
  literals and regular expressions unchanged; CSS and HTML without comments and needless blanks. The C# runtime text
  stays as it is (it is part of every generated file). `web/dist/mii-x-ray.html`: 316 KB -> 249 KB, of which 78 KB are
  the runtime text. Names are not shortened (that needs a parser; the gain is not worth the risk).
- `web/test/minified.mjs`: minifies every module into a copy and X-Rays an export folder with both; corpus 818 of 818
  and Tim's ME_EI/XML_FILE_INTERFACE 146 of 146 files byte-identical (except the generation time), the page script
  parses. Checked in Edge headless against the MUD mock catalog: X-Ray of trxBatchNumberResolve, no console errors.

## 2.7.1 - 2026-11-04

Tim, 2026-11-04: the limit of defaults written into the file is 128 KB (fixed), no longer 16 KB.

- A default larger than 128 KB (UTF-8 bytes) stands as `[n-bytes]`; everything up to 128 KB is in the code. Found in
  bls-project-003: the simulation of an X-Ray runs with the defaults of the file, and the 30 KB XSLT local of
  trxGetSfcOperation started empty with the 16 KB limit (XSLT compile error).
- `web/test/defaults.mjs` tests the limit with 140000-byte defaults.

## 2.7.0 - 2026-11-04

Tim, 2026-11-04: the X-Ray of ME_EI/XML_FILE_INTERFACE (made with 2.5.1 on MII) did not compile, and defaults stood
only in comments.

- Why it did not compile: the line break in the description of `Persistent.SP_TARGET_ADDRESS_TAG_MAPPING` (fixed in
  2.6.4). Every other error of that file (the "using" errors CS1529 and the string errors) followed from that one
  line; with it the file compiles as it is. The page on MII has to be replaced by this version.
- Defaults are set in the code as MII sets them (this replaces the decision of 2026-10-28, defaults as comments only):
  - an input has its MII default as parameter default (text, boolean, numbers), so a caller that does not link it
    gets the default, as in MII; XML, list, map and date inputs get it in the first lines of the method
    (`x ??= ...;`, `if (x == default) { x = ...; }`);
  - outputs and locals start with their MII default, XML in full (no shortened sample any more), a rowset document as
    rows (`Mii.ToRows<T>(Mii.ParseXml(...))`);
  - the declaration comment gives the default only where the code does not hold it (a local declared where the flow
    sets it, a value C# cannot take as it is).
- A default larger than 16 KB (UTF-8 bytes) is not written into the file: it stands as `[n-bytes]` (a text input or
  local gets the text `"[n-bytes]"`, any other type starts empty and the comment says `default: [n-bytes]`). The same
  for shared property defaults and query parameter defaults in the header. ME_EI/XML_FILE_INTERFACE: 2.6 MB -> 1.2 MB.
- `UseTypedParams` is typed only for `T`; `true` counts as off, as MII runs it (bls-project-003, 2026-10-31).
- An XML web file the Catalog answers as MII's HTML rendering of a Name/Type/Payload rowset ("xMII Dynamic HTML") is
  decoded from its Payload, so `MiiFiles` holds the XML (bls-project-002 finding X3; the HTML form was seen in
  2.5.1 output, the decoding is unverified on MII).
- Simulation: inputs take the defaults the code holds (`MiiSim.InputOr`); a multi-line action setting keeps its
  empty lines (bls-project-002 finding X4, a value stopped at its first empty line).
- `web/test/defaults.mjs`: 19 checks (defaults of every type called without arguments and from a caller, 16 KB limit);
  corpus 818/818, simrun 58/58, staticfiles, Tim's export of ME_EI/XML_FILE_INTERFACE 146/146 in both modes.

## 2.6.4 - 2026-10-29

Gaps found X-Raying ME_EI and ME/Production/Release (bls-project-002):

- A shared property whose description (or any other setting) has a line break broke the header: the next line had
  no `//` and the file did not compile. The settings of a shared property are one line now (line breaks as spaces,
  as in the query overview), and every comment line of the file that still carries a line break of an MII text goes
  on as comment lines.
- `append(list, value1, ...)` takes any number of values (`Mii.Append` was two-argument only, CS1501 with five);
  each value is appended to the list itself (by reference, as before).
- `web/test/simrun.mjs`: 58 checks; `web/test/staticfiles.mjs` checks a description with a line break.

## 2.6.3 - 2026-10-28

- A row record read from an MII document (query result, `Mii.ToRows`) stands for the Row it was read from: its text,
  `Mii.ToXml` and a repeater item over the rows keep every column, also when the record has none (`select *`).
  A column the code changes afterwards wins over the text read.
- Checked, no change: XPath expressions with line breaks between tokens run (simrun). The Z_RETRY_MODE expression of
  trxPhaseIncreaseQtyMultiple / trxPhaseProductiveMultiple fails because its predicate is not closed
  (`count(//Row/Value[Key = 'Z_RETRY_MODE' and (...))` has no `]`); Java's XPath refuses that as well, so the
  simulation raises the error as MII would (a defect of the object, not of the runtime).
- Dynamic expressions in literals also for actions and loops: `#Action.Property#`, `#Action.Property{xpath}#`,
  `#Repeater.Item{xpath}#`, `#Iterator.CurrentItem#` (the item of the enclosing loop; an action that has not run is
  "Invalid variable"). A loop item read after its loop is the last item ("Invalid variable" when the loop has not run).
- `web/test/simrun.mjs`: 57 checks.

## 2.6.2 - 2026-10-28

Gaps the simulation harness found running 205 scenarios of today's objects against the rebuilt package.

Runtime (both modes):

- `stringindexof` / `stringlastindexof` count from 1 and give 0 for a missing part (measured on MII 28.10.2026:
  `stringindexof("football", "ball")` = 5); before they were .NET's 0-based index with -1.
- Row records read from an MII document (`Mii.ToRows`) keep the document (`MiiRowList`, `IMiiDocument`): XPaths,
  `Mii.ToXml` and the text of the rows see every rowset and every column, also the ones the record does not know
  (two spellings of a column, a reference document with fewer columns). Adding rows drops the document.
- `DateTime.MinValue` (a NULL date, an unset dateTime) is the text `TimeUnavailable`, as MII writes a NULL date
  (assumed for an unset dateTime property).
- A repeater item (and any node taken out of its document) keeps the namespace declarations in scope.
- Append XML / Append After XML of several nodes appends each.

Simulation:

- `IQueryService.Execute` returns `SimQueryResult`: every result set of the statement (`Rowsets`, each with
  `Columns` name/database type and `Rows`). The runtime builds MII's document with one Rowset per result set
  (`/Rowsets/Rowset[2]/Row` works), a NULL date is `TimeUnavailable`, a NULL number `NA`, a NULL text `---`;
  NumberFormat applies to floating-point columns by their database type. The typed rows are the rows of all
  rowsets (as the XPath /Rowsets/Rowset/Row selects them). Breaking change against 2.6.0/2.6.1
  (`IList<IDictionary<string,string>>`); `SimQueryResult.Of(rows)` for one result set without types.
- Append XML / Append After XML of `Doc{xpath}` appends the selected nodes (the default file reads the text of the
  first node).
- Plugin settings that MII evaluates as references (`...Source`: Distinct ValueSource, GenericSortFilter Source,
  Joiner ParentSource/ChildSource) get the value (`Local.X{/path}`: the selected nodes, `Action.Output`).
- `#Transaction.X#` and `#Local.X#` (also `{key}` / `{xpath}`) in a literal (XPath, regular expression, text) are
  put in at runtime (`MiiSim.Dynamic`); other `#...#` stay as they are.
- An XSL transformation without a stylesheet (Transform and InputXSL empty) or with a web file the service does not
  give fails with a message that says so (MII fails the action).
- `NA` linked into a number gives 0 (assumed: the null of a number; MII's conversion is not documented);
  `TimeUnavailable` linked into a dateTime is the empty date.
- `web/test/simrun.mjs`: 51 checks (several rowsets, NULL date, count in getlistfromxpath, reference document rows,
  repeater namespaces, Append XML of nodes, Distinct and Joiner sources, `#Local.X#`, missing stylesheet, NA, index).

## 2.6.1 - 2026-10-28

Runtime gaps the simulation harness (`C:\Claude\pp\sim`) found on today's ME/ProductionProcess objects.

- XPath: an expression whose result is a number, text or boolean (`count(...)`, `sum(...) div 4`, `string(...)`) gives
  its value as text in `Doc{...}`, `getlistfromxpath` (one element) and is no error in repeaters, `getmapfromxpath`
  and Assign XML (no nodes). NaN and infinities as Java writes them. A location path ending with `/`
  (`count(/Rowsets/Rowset/Row/)`) is read as the path without it (assumed: such links run in production on MII;
  Java's XPath would refuse the expression).
- Java regular expressions (`match`, `match2`, `stringreplaceall`, `stringtolist` and the `Regex` calls the X-Ray
  writes): possessive quantifiers (`.*+` as an atomic group), `\x{h..h}`, `\Q...\E`, `\h`, `\H`, `\R`, the POSIX
  classes `\p{Lower}` etc., and a backslash before `_` or another non-letter that .NET refuses (`[a-z\_]`).
- `format(number, pattern)` is Java's DecimalFormat (half-even, `0`, `#`, grouping, prefix/suffix, `%`).
- Simulation: a query action's `DateFormat` / `NumberFormat` / `XmlDateFormat` / `XmlNumberFormat` read by a link
  (left unresolved in the default file) is the action's setting, else the template's, else MII's default
  (`MM/dd/yyyy HH:mm:ss`, `yyyy-MM-dd'T'HH:mm:ss`, empty). This was the cause of `"0001-01-01T00:00:00" is no
  dateTime` in trxTimeTicketHandler; a link of `0001-01-01T00:00:00` into a dateTime is no longer refused.
- Simulation: the template's `NumberFormat` (or the action's `XmlNumberFormat` / `NumberFormat`, which win in that
  order: `XmlNumberFormat` of action and template, then `NumberFormat` of action and template) is applied to
  floating-point values of the result with Java's DecimalFormat, half-even (guide: "a non-empty NumberFormat rounds
  every floating-point value"). `SimQuery.NumberFormat` tells the query service; `SimQuery.FloatColumns` may name the
  floating-point columns, otherwise every value with a decimal point or an exponent counts as one (assumed). The value
  is rounded as the decimal it reads as (BigDecimal); a DOUBLE column formatted by Java from its binary value may round
  a tie differently (assumed).
- Simulation: the converted file runs on the current X-Ray runtime, whatever version wrote it (the runtime of a 2.5
  file is replaced); a query service error without an action name gets the action that ran the query (Catch Source).
- `web/test/simrun.mjs`: XPath, Java regex, query DateFormat, NumberFormat and XmlNumberFormat checks (35 in all).

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

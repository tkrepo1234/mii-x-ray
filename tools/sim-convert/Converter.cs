using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace MiiXRay.SimConvert;

/// <summary>A change of the source text: an insertion (Start == End) or a replacement.</summary>
public sealed record Edit(int Start, int End, string Text, int Order);

/// <summary>A transaction parameter: C# name and type, MII name and default.</summary>
public sealed record Parameter(string Name, string Type, Declaration Declaration);

/// <summary>A query template from the file header.</summary>
public sealed class Template
{
    public string Path { get; set; }

    public string Kind { get; set; }

    public string Mode { get; set; }

    public bool Typed { get; set; }

    public Dictionary<int, string> Defaults { get; } = [];

    public Dictionary<int, string> Types { get; } = [];

    public Dictionary<int, string> Names { get; } = [];

    /// <summary>The template settings of the header overview (DateFormat, NumberFormat, ...).</summary>
    public Dictionary<string, string> Settings { get; } = [];

    public string Setting(string name) => Settings.TryGetValue(name, out string value) ? value : "";
}

/// <summary>Turns a default-mode X-Ray into the simulation mode (see SimulationRuntime.txt for what it emulates).</summary>
public sealed class Converter(List<MetadataReference> references)
{
    public const string ToolVersion = "2.6.3";

    private const string ServicesRegion = "#region Services (implement these to run the code)";

    private static readonly string[] StrictConversions = ["ToInt", "ToLong", "ToDouble", "ToDecimal", "ToDateTime"];

    private static readonly string Runtime = LoadRuntime("MiiXRay.SimulationRuntime.txt");

    /// <summary>The current X-Ray runtime: a converted file runs on it whatever version wrote the file.</summary>
    private static readonly string XRayRuntime = LoadRuntime("MiiXRay.RuntimeSource.txt");

    public string Convert(string original)
    {
        string text = original.TrimStart('﻿').Replace("\r\n", "\n");

        if (text.Contains("#region MII simulation"))
        {
            throw new InvalidOperationException("the file is already in simulation mode");
        }

        if (!text.Contains(ServicesRegion))
        {
            throw new InvalidOperationException("no X-Ray file (the runtime region is missing)");
        }

        SyntaxTree tree = CSharpSyntaxTree.ParseText(text, new CSharpParseOptions(LanguageVersion.CSharp12));
        CSharpCompilation compilation = CSharpCompilation.Create("XRay", [tree], references, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        FileConversion conversion = new FileConversion(text, tree.GetCompilationUnitRoot(), compilation.GetSemanticModel(tree));
        conversion.Run();
        return Apply(text, conversion.Edits).Replace("\n", "\r\n");
    }

    private static string LoadRuntime(string name)
    {
        using Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        using StreamReader reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd().TrimStart('﻿').Replace("\r\n", "\n");
    }

    private static string Apply(string text, List<Edit> edits)
    {
        StringBuilder result = new StringBuilder();
        int cursor = 0;

        foreach (Edit edit in edits.OrderBy((item) => item.Start).ThenBy((item) => item.Order))
        {
            if (edit.Start < cursor)
            {
                throw new InvalidOperationException("overlapping changes at " + edit.Start + ": " + edit.Text);
            }

            result.Append(text, cursor, edit.Start - cursor).Append(edit.Text);
            cursor = edit.End;
        }

        return result.Append(text, cursor, text.Length - cursor).ToString();
    }

    /// <summary>The conversion of one file.</summary>
    private sealed class FileConversion(string text, CompilationUnitSyntax unit, SemanticModel model)
    {
        // order of edits at one position: closing parentheses (inner first), then insertions (outer first), then replacements
        private const int Closing = 0;
        private const int Opening = 100;
        private const int Replacing = 200;

        private readonly Dictionary<string, MethodInfo> methods = [];
        private readonly Dictionary<string, List<(string Property, string Type, string MiiName)>> records = [];
        private readonly Dictionary<string, Template> templates = new(StringComparer.OrdinalIgnoreCase);
        private string simulation;

        public List<Edit> Edits { get; } = [];

        public void Run()
        {
            ClassDeclarationSyntax logic = unit.DescendantNodes().OfType<ClassDeclarationSyntax>()
                .FirstOrDefault((item) => item.ParameterList != null && item.ParameterList.Parameters.Count == 2 && item.ParameterList.Parameters[0].Type.ToString() == "IQueryService")
                ?? throw new InvalidOperationException("the logic class (IQueryService queries, IPluginService plugins) is missing");
            simulation = FreeName(logic, "simulation");
            ReadHeader();
            ReadRecords();

            foreach (MethodDeclarationSyntax method in logic.Members.OfType<MethodDeclarationSyntax>())
            {
                MethodInfo info = MethodInfo.Read(method);
                methods[method.Identifier.Text] = info;
            }

            foreach (MethodInfo method in methods.Values)
            {
                if (method.IsQueryMethod)
                {
                    ConvertQueryMethod(method);
                }
                else
                {
                    new MethodConversion(this, method).Run();
                }
            }

            ConvertClass(logic);
            ConvertHeader();
            ConvertRuntime();
        }

        // ---------------------------------------------------------------------------------------------- file parts

        /// <summary>The query overview of the header: mode, typed parameters, saved Param.N.</summary>
        private void ReadHeader()
        {
            Template current = null;
            Regex entry = new Regex(@"^//   (\S+) = (.+) \((SQLQuery|MDOQuery) ?([^()]*)\)$");

            foreach (string line in text.Split('\n').TakeWhile((item) => item.StartsWith("//")))
            {
                Match match = entry.Match(line);

                if (match.Success)
                {
                    current = new Template { Path = match.Groups[2].Value, Kind = match.Groups[3].Value, Mode = match.Groups[4].Value.Trim() };
                    templates[current.Path] = current;
                    continue;
                }

                if (current == null || !line.StartsWith("//     "))
                {
                    current = line.StartsWith("//     ") ? current : null;
                    continue;
                }

                string content = line.Substring(7);

                if (content.StartsWith("parameters"))
                {
                    current.Typed = content.StartsWith("parameters (typed");
                    string list = content.Substring(content.IndexOf(": ", StringComparison.Ordinal) + 2);

                    foreach (string item in Regex.Split(list, @", (?=\[Param\.\d+\] )"))
                    {
                        Match slot = Regex.Match(item, @"^\[Param\.(\d+)\] (.*)$");

                        if (!slot.Success)
                        {
                            continue;
                        }

                        int number = int.Parse(slot.Groups[1].Value);
                        string name = slot.Groups[2].Value;

                        if (current.Typed)
                        {
                            Match typed = Regex.Match(name, @"^(.*) (\(no type\)|\S+)$");

                            if (typed.Success)
                            {
                                name = typed.Groups[1].Value;
                                current.Types[number] = typed.Groups[2].Value == "(no type)" ? "" : typed.Groups[2].Value;
                            }
                        }

                        current.Names[number] = name;
                    }
                }
                else if (content.StartsWith("parameter defaults: "))
                {
                    foreach (string item in Regex.Split(content.Substring("parameter defaults: ".Length), @", (?=\[Param\.\d+\] = )"))
                    {
                        Match slot = Regex.Match(item, @"^\[Param\.(\d+)\] = (.*)$");

                        if (slot.Success)
                        {
                            current.Defaults[int.Parse(slot.Groups[1].Value)] = slot.Groups[2].Value;
                        }
                    }
                }
                else if (content.StartsWith("settings: "))
                {
                    foreach (string item in Regex.Split(content.Substring("settings: ".Length), @", (?=[A-Za-z][\w.]* = )"))
                    {
                        int equals = item.IndexOf(" = ", StringComparison.Ordinal);

                        if (equals > 0)
                        {
                            current.Settings[item.Substring(0, equals)] = item.Substring(equals + 3);
                        }
                    }
                }
            }
        }

        private void ReadRecords()
        {
            foreach (RecordDeclarationSyntax record in unit.DescendantNodes().OfType<RecordDeclarationSyntax>().Where((item) => item.ParameterList != null))
            {
                List<(string, string, string)> properties = [];

                foreach (ParameterSyntax parameter in record.ParameterList.Parameters)
                {
                    Declaration declaration = Comments.ParseDeclaration(Comments.TrailingLines(parameter));
                    properties.Add((parameter.Identifier.Text, parameter.Type.ToString(), declaration?.MiiName ?? parameter.Identifier.ValueText));
                }

                records[record.Identifier.Text] = properties;
            }
        }

        /// <summary>The logic class takes the simulation; TryRun runs a transaction by its path.</summary>
        private void ConvertClass(ClassDeclarationSyntax logic)
        {
            Replace(logic.ParameterList.Span, "(MiiSim " + simulation + ") : IMiiSimLogic");
            string[] memberLines = [
                "    private readonly MiiSimQueries queries = " + simulation + ".Queries;",
                "",
                "    private readonly IPluginService plugins = " + simulation + ".Plugins;",
                "",
                "    /// <summary>The simulation the transactions run in.</summary>",
                "    public MiiSim Simulation => " + simulation + ";",
                "",
                ""];
            string members = string.Join("\n", memberLines);
            Insert(logic.OpenBraceToken.FullSpan.End, members, Opening);
            List<string> lines = [
                "    /// <summary>Runs a transaction of this file by its MII path, the inputs and outputs as MII text (MiiSim.Run).</summary>",
                "    public bool TryRun(string path, IDictionary<string, string> inputs, out IDictionary<string, string> outputs)",
                "    {"];

            foreach (MethodInfo method in methods.Values.Where((item) => !item.IsQueryMethod))
            {
                List<string> arguments = method.Parameters.Select((parameter) => parameter.Name + ": MiiSim.FromText<" + parameter.Type + ">(inputs, "
                    + Comments.Literal(parameter.Declaration?.MiiName ?? parameter.Name) + ")").ToList();
                string call = method.Node.Identifier.Text + "(" + (arguments.Count == 0 ? ")" : "\n                " + string.Join(",\n                ", arguments) + ")");
                lines.Add("        if (string.Equals(path, " + Comments.Literal(method.Path) + ", StringComparison.OrdinalIgnoreCase))");
                lines.Add("        {");

                if (method.ReturnType == "void")
                {
                    lines.Add("            " + call + ";");
                    lines.Add("            outputs = new Dictionary<string, string>();");
                }
                else
                {
                    lines.Add("            var result = " + call + ";");
                    lines.Add("            outputs = new Dictionary<string, string>");
                    lines.Add("            {");

                    foreach ((string property, string miiName) in OutputsOf(method))
                    {
                        lines.Add("                [" + Comments.Literal(miiName) + "] = MiiSim.ToText(result" + (property == null ? "" : "." + property) + "),");
                    }

                    lines.Add("            };");
                }

                lines.Add("            return true;");
                lines.Add("        }");
                lines.Add("");
            }

            lines.Add("        outputs = null;");
            lines.Add("        return false;");
            lines.Add("    }");
            Insert(logic.CloseBraceToken.SpanStart, "\n" + string.Join("\n", lines) + "\n", Opening);
        }

        /// <summary>The outputs of a method: (record property or null for a single output, MII name).</summary>
        public List<(string Property, string MiiName)> OutputsOf(MethodInfo method)
        {
            if (records.TryGetValue(method.ReturnType, out List<(string Property, string Type, string MiiName)> properties))
            {
                return properties.Select((item) => (item.Property, item.MiiName)).ToList();
            }

            Declaration output = method.TopDeclarations.Select((item) => item.Declaration).FirstOrDefault((item) => item != null && item.Scope == "Transaction");
            return [(null, output?.MiiName ?? "Output")];
        }

        public List<(string Property, string Type, string MiiName)> RecordOf(string type) => records.TryGetValue(type, out var properties) ? properties : null;

        private void ConvertHeader()
        {
            int generated = text.IndexOf("\n// Generated ", StringComparison.Ordinal);
            int position = text.IndexOf('\n', generated + 1) + 1;
            string className = unit.DescendantNodes().OfType<ClassDeclarationSyntax>().First((item) => item.ParameterList != null && item.ParameterList.Parameters.Count == 2).Identifier.Text;
            string[] lines = [
                "//",
                "// SIMULATION MODE (converted by MII X-Ray " + ToolVersion + ", tools/sim-convert): the code runs the way MII runs the",
                "// transactions: ThrowOnLinkError and ThrowOnActionError of each transaction, \"Invalid variable\" for an output of an",
                "// action that has not run, ResetState of the call actions, the defaults of inputs, locals and outputs, the saved",
                "// Param.N of the query templates. Run a transaction with",
                "//   MiiSim.Run(new " + className + "(new MiiSim(queries, plugins)), \"<path>\", inputs)",
                "// (inputs and outputs as MII text). The region \"MII simulation\" at the end lists the rules; the reading rules below",
                "// describe the code of the default mode, which this file keeps apart from the wrappers (Link, In, Arg, Read, Action).",
            ];
            Insert(position, string.Join("\n", lines) + "\n", Opening);
        }

        private void ConvertRuntime()
        {
            int start = text.IndexOf(ServicesRegion, StringComparison.Ordinal);
            int split = Runtime.IndexOf("#region MII simulation", StringComparison.Ordinal);
            int region = XRayRuntime.IndexOf("#region X-Ray runtime", StringComparison.Ordinal);
            Replace(new Microsoft.CodeAnalysis.Text.TextSpan(start, text.Length - start), TemplatesClass() + "\n" + Runtime.Substring(0, split).TrimEnd()
                + "\n\n" + XRayRuntime.Substring(region).TrimEnd() + "\n\n" + Runtime.Substring(split).TrimEnd() + "\n");
        }

        private string TemplatesClass()
        {
            List<string> lines = [
                "/// <summary>The query templates as the file header describes them (mode, typed parameters, saved Param.N).</summary>",
                "public static class MiiSimTemplates",
                "{",
                "    public static readonly Dictionary<string, MiiSimTemplate> All = new(StringComparer.OrdinalIgnoreCase)",
                "    {"];

            foreach (Template template in templates.Values)
            {
                lines.Add("        [" + Comments.Literal(template.Path) + "] = new(" + Comments.Literal(template.Kind) + ", " + Comments.Literal(template.Mode) + ", "
                    + (template.Typed ? "true" : "false") + ", " + Slots(template.Defaults) + ", " + Slots(template.Types) + ", " + Slots(template.Names)
                    + ", " + Comments.Literal(template.Setting("NumberFormat")) + ", " + Comments.Literal(template.Setting("XmlNumberFormat"))
                    + ", " + Comments.Literal(template.Setting("DateFormat")) + "),");
            }

            lines.Add("    };");
            lines.Add("}");
            lines.Add("");
            return string.Join("\n", lines);
        }

        private static string Slots(Dictionary<int, string> values) =>
            values.Count == 0 ? "new()" : "new() { " + string.Join(", ", values.OrderBy((pair) => pair.Key).Select((pair) => "[" + pair.Key + "] = " + Comments.Literal(pair.Value))) + " }";

        /// <summary>A query template no transaction runs: the query knows its template, the parameters their slots.</summary>
        private void ConvertQueryMethod(MethodInfo method)
        {
            foreach (StatementSyntax statement in method.Node.Body.Statements)
            {
                ConvertQueryStatement(statement, method.Path, null, null);
            }
        }

        // ---------------------------------------------------------------------------------------------- shared helpers

        public Dictionary<string, MethodInfo> Methods => methods;

        public Dictionary<string, Template> Templates => templates;

        public SemanticModel Model => model;

        public string Simulation => simulation;

        public Dictionary<string, Dictionary<string, int>> QuerySlots { get; } = [];

        /// <summary>new Query(text) knows its template; AddParameter / AddTypedParameter become SetParameter with the slot
        /// (and an incoming link in a transaction). Returns true when the statement was one of these.</summary>
        public bool ConvertQueryStatement(StatementSyntax statement, string templatePath, string frame, string actionName, ActionContext context = null)
        {
            if (statement is LocalDeclarationStatementSyntax declaration
                && declaration.Declaration.Variables.Count == 1
                && declaration.Declaration.Variables[0].Initializer?.Value is ObjectCreationExpressionSyntax creation
                && creation.Type.ToString() == "Query"
                && creation.ArgumentList != null)
            {
                string variable = declaration.Declaration.Variables[0].Identifier.Text;
                Dictionary<string, int> slots = [];

                foreach (string line in Comments.Lines(statement.GetLeadingTrivia()))
                {
                    int colon = line.IndexOf("): ", StringComparison.Ordinal);
                    string list = line.StartsWith("// [Param.") ? line.Substring(3) : (line.Contains(" parameters (") && colon > 0) ? line.Substring(colon + 3) : null;

                    if (list == null)
                    {
                        continue;
                    }

                    foreach (string item in Regex.Split(list, @", (?=\[Param\.\d+\] = )"))
                    {
                        Match slot = Regex.Match(item, @"^\[Param\.(\d+)\] = (.*)$");

                        if (!slot.Success)
                        {
                            continue;
                        }

                        string name = slot.Groups[2].Value;

                        if (line.Contains("typed parameters"))
                        {
                            name = Regex.Replace(name, @" (\(no type\)|\S+)$", "");
                        }

                        slots[name] = int.Parse(slot.Groups[1].Value);
                    }
                }

                QuerySlots[variable] = slots;
                Insert(creation.ArgumentList.OpenParenToken.Span.End, Comments.Literal(templatePath ?? "") + ", ", Opening);
                List<string> formats = [];

                foreach (string format in new[] { "NumberFormat", "XmlNumberFormat" })
                {
                    (string Name, string Value, bool Linked) setting = context == null ? default : context.Settings.FirstOrDefault((item) => item.Name == format);

                    if (setting.Name != null && !setting.Linked && setting.Value.Length > 0)
                    {
                        formats.Add(format + " = " + Comments.Literal(setting.Value));
                    }
                }

                if (formats.Count > 0)
                {
                    Insert(creation.Span.End, " { " + string.Join(", ", formats) + " }", Opening);
                }
                return true;
            }

            if (statement is ExpressionStatementSyntax expression
                && expression.Expression is InvocationExpressionSyntax invocation
                && invocation.Expression is MemberAccessExpressionSyntax member
                && member.Expression is IdentifierNameSyntax target
                && QuerySlots.TryGetValue(target.Identifier.Text, out Dictionary<string, int> known)
                && (member.Name.Identifier.Text == "AddParameter" || member.Name.Identifier.Text == "AddTypedParameter")
                && invocation.ArgumentList.Arguments.Count >= 2
                && invocation.ArgumentList.Arguments[0].Expression is LiteralExpressionSyntax nameLiteral)
            {
                string name = nameLiteral.Token.ValueText;

                if (!known.TryGetValue(name, out int slot))
                {
                    Match fallback = Regex.Match(name, @"^Param(\d+)$");

                    if (!fallback.Success)
                    {
                        throw new InvalidOperationException("query " + target.Identifier.Text + ": no slot for the parameter " + name);
                    }

                    slot = int.Parse(fallback.Groups[1].Value);
                }

                Replace(member.Name.Span, member.Name.Identifier.Text == "AddParameter" ? "SetParameter" : "SetTypedParameter");
                Insert(invocation.ArgumentList.OpenParenToken.Span.End, slot + ", ", Opening);

                if (frame != null)
                {
                    ExpressionSyntax value = invocation.ArgumentList.Arguments[^1].Expression;
                    WrapIncoming(frame, value, "object", actionName + ".Param." + slot, "null");
                }

                return true;
            }

            return false;
        }

        /// <summary>An incoming link into an action property: frame.In (a literal or a plain variable cannot fail).</summary>
        public void WrapIncoming(string frame, ExpressionSyntax value, string type, string target, string configured)
        {
            if (!CanFail(value))
            {
                return;
            }

            if (type == "object" && (value is CollectionExpressionSyntax || value is ImplicitObjectCreationExpressionSyntax))
            {
                return;
            }

            Insert(value.SpanStart, frame + ".In<" + type + ">(" + Comments.Literal(target) + ", () => ", Opening + 2);
            Insert(value.Span.End, ", " + configured + ")", Closing + 8);
        }

        public HashSet<string> ActionVariables { get; set; } = [];

        public bool CanFail(ExpressionSyntax value)
        {
            if (value is LiteralExpressionSyntax || value is DefaultExpressionSyntax)
            {
                return false;
            }

            return !(value is IdentifierNameSyntax identifier) || ActionVariables.Contains(identifier.Identifier.Text);
        }

        /// <summary>Mii.ToInt(x) and the like at the top of a link: MII's conversion fails on text that is no number.</summary>
        public bool Strict(ExpressionSyntax value)
        {
            if (value is InvocationExpressionSyntax invocation
                && invocation.Expression is MemberAccessExpressionSyntax member
                && member.Expression.ToString() == "Mii"
                && StrictConversions.Contains(member.Name.Identifier.Text)
                && invocation.ArgumentList.Arguments.Count == 1)
            {
                Replace(member.Span, "MiiSim.Link" + member.Name.Identifier.Text);
                return true;
            }

            return false;
        }

        public void Insert(int position, string insertion, int order) => Edits.Add(new Edit(position, position, insertion, order));

        public void Replace(Microsoft.CodeAnalysis.Text.TextSpan span, string replacement) => Edits.Add(new Edit(span.Start, span.End, replacement, Replacing));

        public void ReplaceRange(int start, int end, string replacement) => Edits.Add(new Edit(start, end, replacement, Replacing));

        public static string FreeName(SyntaxNode scope, string wanted)
        {
            HashSet<string> used = scope.DescendantTokens().Where((token) => token.IsKind(SyntaxKind.IdentifierToken)).Select((token) => token.ValueText).ToHashSet();
            string name = wanted;

            for (int number = 2; used.Contains(name); number++)
            {
                name = wanted + number;
            }

            return name;
        }
    }

    /// <summary>A method of the logic class as the X-Ray wrote it.</summary>
    private sealed class MethodInfo
    {
        public MethodDeclarationSyntax Node { get; private set; }

        public string Path { get; private set; } = "";

        public bool IsQueryMethod { get; private set; }

        public bool ThrowOnLinkError { get; private set; } = true;

        public bool ThrowOnActionError { get; private set; } = true;

        public string ReturnType => Node.ReturnType.ToString();

        public List<Parameter> Parameters { get; } = [];

        public List<(LocalDeclarationStatementSyntax Statement, Declaration Declaration)> TopDeclarations { get; } = [];

        public List<StatementSyntax> Flow { get; } = [];

        public ReturnStatementSyntax FinalReturn { get; private set; }

        public static MethodInfo Read(MethodDeclarationSyntax method)
        {
            MethodInfo info = new MethodInfo { Node = method };
            SyntaxTrivia documentation = method.GetLeadingTrivia().FirstOrDefault((item) => item.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia));
            List<string> lines = documentation.ToFullString().Split('\n').Select((line) => line.Trim()).Where((line) => line.StartsWith("///"))
                .Select((line) => line.Substring(3).Trim()).ToList();
            int summary = lines.IndexOf("<summary>");

            if (summary >= 0 && summary + 1 < lines.Count)
            {
                string first = System.Net.WebUtility.HtmlDecode(lines[summary + 1]);
                info.IsQueryMethod = first.EndsWith(" (query template, no transaction runs it)");
                info.Path = info.IsQueryMethod ? first.Substring(0, first.Length - " (query template, no transaction runs it)".Length) : first;
            }

            string attributes = lines.FirstOrDefault((line) => line.StartsWith("MII transaction attributes: "));

            if (attributes != null)
            {
                attributes = System.Net.WebUtility.HtmlDecode(attributes);
                info.ThrowOnLinkError = Flag(attributes, "ThrowOnLinkError");
                info.ThrowOnActionError = Flag(attributes, "ThrowOnActionError");
            }

            foreach (ParameterSyntax parameter in method.ParameterList.Parameters)
            {
                Declaration declaration = Comments.ParseDeclaration(Comments.Lines(parameter.GetLeadingTrivia())) ?? Comments.ParseDeclaration(Comments.TrailingLines(parameter));
                info.Parameters.Add(new Parameter(parameter.Identifier.Text, parameter.Type.ToString(), declaration));
            }

            if (method.Body == null)
            {
                return info;
            }

            List<StatementSyntax> statements = method.Body.Statements.ToList();
            int index = 0;

            for (; index < statements.Count; index++)
            {
                if (statements[index] is not LocalDeclarationStatementSyntax local || local.Declaration.Type.IsVar)
                {
                    break;
                }

                Declaration declaration = Comments.ParseDeclaration(Comments.TrailingLines(local)) ?? Comments.ParseDeclaration(Comments.Lines(local.GetLeadingTrivia()));

                if (declaration == null)
                {
                    break;
                }

                info.TopDeclarations.Add((local, declaration));
            }

            if (statements.Count > index && statements[^1] is ReturnStatementSyntax final && info.ReturnType != "void" && statements.Count - 1 >= index)
            {
                info.FinalReturn = final;
                statements.RemoveAt(statements.Count - 1);
            }

            info.Flow.AddRange(statements.Skip(index));
            return info;
        }

        /// <summary>A transaction attribute that is missing counts as true (assumed: new transactions store true).</summary>
        private static bool Flag(string attributes, string name)
        {
            Match match = Regex.Match(attributes, "(?:^|[:,] )" + name + " = ([^,]*)");
            return !match.Success || Regex.IsMatch(match.Groups[1].Value, @"^\s*(true|1)\s*$", RegexOptions.IgnoreCase);
        }
    }

    /// <summary>The conversion of one transaction method.</summary>
    private sealed class MethodConversion(FileConversion file, MethodInfo method)
    {
        private readonly Dictionary<string, string> actionVariables = [];
        private readonly List<(string Name, string Type, Declaration Declaration)> hoisted = [];
        private readonly HashSet<LocalDeclarationStatementSyntax> hoistedStatements = [];
        private string frame;

        public void Run()
        {
            BlockSyntax body = method.Node.Body;
            frame = FileConversion.FreeName(method.Node, "frame");
            string external = FileConversion.FreeName(method.Node, "external");
            string exit = FileConversion.FreeName(method.Node, "exit");
            string indent = "        ";

            foreach ((LocalDeclarationStatementSyntax statement, Declaration declaration) in method.TopDeclarations)
            {
                if (declaration.Scope == "action" && statement.Declaration.Type.ToString() != "Exception")
                {
                    actionVariables[statement.Declaration.Variables[0].Identifier.Text] = declaration.MiiName;
                }
            }

            // locals and action results the X-Ray declared where they are set: declared at the top
            foreach (StatementSyntax statement in method.Flow.SelectMany((item) => item.DescendantNodesAndSelf().OfType<LocalDeclarationStatementSyntax>()))
            {
                LocalDeclarationStatementSyntax local = (LocalDeclarationStatementSyntax)statement;

                if (!local.Declaration.Type.IsVar || local.Declaration.Variables.Count != 1)
                {
                    continue;
                }

                Declaration declaration = Comments.ParseDeclaration(Comments.TrailingLines(local)) ?? Comments.ParseDeclaration(Comments.Lines(local.GetLeadingTrivia()));

                if (declaration == null)
                {
                    continue;
                }

                ITypeSymbol type = file.Model.GetTypeInfo(local.Declaration.Type).Type;

                if (type == null || type.TypeKind == TypeKind.Error)
                {
                    throw new InvalidOperationException(method.Path + ": the type of " + local.Declaration.Variables[0].Identifier.Text + " is unknown");
                }

                string name = local.Declaration.Variables[0].Identifier.Text;
                hoisted.Add((name, type.ToMinimalDisplayString(file.Model, local.SpanStart), declaration));
                hoistedStatements.Add(local);

                if (declaration.Scope == "action" && type.Name != "Exception")
                {
                    actionVariables[name] = declaration.MiiName;
                }
            }

            file.ActionVariables = actionVariables.Keys.ToHashSet();

            foreach (Parameter parameter in method.Parameters)
            {
                variablesByKey["Transaction." + MiiName(parameter)] = (parameter.Name, parameter.Type);
            }

            foreach ((LocalDeclarationStatementSyntax statement, Declaration declaration) in method.TopDeclarations)
            {
                variablesByKey[declaration.Key] = (statement.Declaration.Variables[0].Identifier.Text, statement.Declaration.Type.ToString());
            }

            foreach ((string name, string type, Declaration declaration) in hoisted)
            {
                variablesByKey[declaration.Key] = (name, type);
            }

            WrapReads();
            ConvertStatements();
            ResolveQuerySettings();
            WrapRegexPatterns();
            ConvertXmlSources();
            WrapDynamicLiterals();

            // the start: enter, external call, inputs
            List<string> head = [indent + "var " + frame + " = " + file.Simulation + ".Enter(" + Comments.Literal(method.Path) + ", "
                + (method.ThrowOnLinkError ? "true" : "false") + ", " + (method.ThrowOnActionError ? "true" : "false") + ");", ""];
            head.Add(indent + "if (" + frame + ".External)");
            head.Add(indent + "{");
            string inputs = method.Parameters.Count == 0 ? "new Dictionary<string, object>()"
                : "new Dictionary<string, object> { " + string.Join(", ", method.Parameters.Select((parameter) => "[" + Comments.Literal(MiiName(parameter)) + "] = " + parameter.Name)) + " }";
            head.Add(indent + "    var " + external + " = " + frame + ".CallExternal(" + inputs + ");");
            head.Add(indent + "    " + ExternalReturn(external));
            head.Add(indent + "}");
            head.Add("");

            foreach (Parameter parameter in method.Parameters)
            {
                head.Add(indent + parameter.Name + " = " + frame + ".Input<" + parameter.Type + ">(" + Comments.Literal(MiiName(parameter)) + ", " + parameter.Name + ", "
                    + Comments.Literal(parameter.Declaration?.DefaultText ?? "") + ");");
            }

            if (method.Parameters.Count > 0 && method.TopDeclarations.Count == 0)
            {
                head.Add("");
            }

            int headPosition = body.Statements.Count > 0 ? body.Statements[0].FullSpan.Start : body.OpenBraceToken.FullSpan.End;
            file.Insert(headPosition, string.Join("\n", head) + "\n", 100);

            // top declarations start with their MII default (or the value of the previous call)
            foreach ((LocalDeclarationStatementSyntax statement, Declaration declaration) in method.TopDeclarations)
            {
                VariableDeclaratorSyntax variable = statement.Declaration.Variables[0];
                string type = statement.Declaration.Type.ToString();
                string value = declaration.DefaultText != null
                    ? frame + ".InitText<" + type + ">(" + Comments.Literal(declaration.Key) + ", " + Comments.Literal(declaration.DefaultText) + ")"
                    : frame + ".Init<" + type + ">(" + Comments.Literal(declaration.Key) + ", " + variable.Initializer.Value + ")";
                file.Replace(variable.Initializer.Value.Span, value);
            }

            // hoisted declarations and the keeping of the state at the end
            List<string> tail = [];

            foreach ((string name, string type, Declaration declaration) in hoisted)
            {
                string value = declaration.DefaultText != null
                    ? frame + ".InitText<" + type + ">(" + Comments.Literal(declaration.Key) + ", " + Comments.Literal(declaration.DefaultText) + ")"
                    : frame + ".Init<" + type + ">(" + Comments.Literal(declaration.Key) + ", " + EmptyValue(type) + ")";
                tail.Add(indent + type + " " + name + " = " + value + "; // " + declaration.Key);
            }

            List<string> kept = method.Parameters.Select((parameter) => (Key: "Transaction." + MiiName(parameter), Name: parameter.Name))
                .Concat(method.TopDeclarations.Select((item) => (Key: item.Declaration.Key, Name: item.Statement.Declaration.Variables[0].Identifier.Text)))
                .Concat(hoisted.Select((item) => (Key: item.Declaration.Key, Name: item.Name)))
                .Select((item) => indent + "    " + frame + ".Keep(" + Comments.Literal(item.Key) + ", " + item.Name + ");").ToList();

            if (kept.Count > 0)
            {
                if (tail.Count > 0 || method.TopDeclarations.Count > 0)
                {
                    tail.Add("");
                }

                tail.Add(indent + "using var " + exit + " = " + frame + ".OnExit(() =>");
                tail.Add(indent + "{");
                tail.AddRange(kept);
                tail.Add(indent + "});");
            }

            if (tail.Count > 0)
            {
                StatementSyntax next = method.Flow.Count > 0 ? method.Flow[0] : method.FinalReturn;
                int position = next != null ? next.FullSpan.Start : body.CloseBraceToken.FullSpan.Start;
                bool blank = next == null || !next.GetLeadingTrivia().ToFullString().StartsWith("\n");
                file.Insert(position, string.Join("\n", tail) + "\n" + (blank && next != null ? "\n" : ""), 101);
            }
        }

        private static string MiiName(Parameter parameter) => parameter.Declaration?.MiiName ?? parameter.Name;

        private string ExternalReturn(string external)
        {
            if (method.ReturnType == "void")
            {
                return "return;";
            }

            List<(string Property, string Type, string MiiName)> record = file.RecordOf(method.ReturnType);

            if (record != null)
            {
                return "return new " + method.ReturnType + "(" + string.Join(", ", record.Select((item) => "MiiSim.FromText<" + item.Type + ">(" + external + ", " + Comments.Literal(item.MiiName) + ")")) + ");";
            }

            return "return MiiSim.FromText<" + method.ReturnType + ">(" + external + ", " + Comments.Literal(file.OutputsOf(method)[0].MiiName) + ");";
        }

        private static string EmptyValue(string type)
        {
            switch (type)
            {
                case "string": return "\"\"";
                case "bool": return "false";
                case "int":
                case "long":
                case "double":
                case "decimal": return "0";
                case "DateTime": return "DateTime.MinValue";
                case "XmlDocument":
                case "PluginResult":
                case "Dictionary<string, string>": return "new()";
                default: return type.StartsWith("List<") ? "[]" : "default";
            }
        }

        /// <summary>Every read of an action's result checks that the action has run ("Invalid variable").</summary>
        private void WrapReads()
        {
            foreach (StatementSyntax statement in method.Flow)
            {
                foreach (IdentifierNameSyntax identifier in statement.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
                {
                    if (!actionVariables.TryGetValue(identifier.Identifier.Text, out string actionName))
                    {
                        continue;
                    }

                    SyntaxNode parent = identifier.Parent;

                    if (parent is NameColonSyntax
                        || (parent is MemberAccessExpressionSyntax access && access.Name == identifier)
                        || (parent is AssignmentExpressionSyntax assignment && assignment.Left == identifier))
                    {
                        continue;
                    }

                    file.Replace(identifier.Span, frame + ".Read(" + Comments.Literal(actionName) + ", " + identifier.Identifier.Text + ")");
                }
            }
        }

        private void ConvertStatements()
        {
            ActionContext context = new ActionContext();

            foreach (StatementSyntax statement in method.Flow.SelectMany((item) => item.DescendantNodesAndSelf().OfType<StatementSyntax>()))
            {
                context = Comments.Update(context, Comments.Lines(statement.GetLeadingTrivia()));

                if (!string.IsNullOrWhiteSpace(context.Setting("QueryTemplate")))
                {
                    queryActions[context.Name] = context;
                }

                if (statement is ExpressionStatementSyntax || statement is LocalDeclarationStatementSyntax)
                {
                    ConvertLeaf(statement, context);
                }
            }
        }

        private readonly Dictionary<string, ActionContext> queryActions = [];

        private static readonly Dictionary<string, string> FormatDefaults = new()
        {
            ["DateFormat"] = "MM/dd/yyyy HH:mm:ss",
            ["XmlDateFormat"] = "yyyy-MM-dd'T'HH:mm:ss",
            ["NumberFormat"] = "",
            ["XmlNumberFormat"] = "",
        };

        /// <summary>Query.DateFormat and the like, which the default mode leaves unresolved: the action's setting, else the
        /// template's, else MII's default (DateFormat MM/dd/yyyy HH:mm:ss).</summary>
        private void ResolveQuerySettings()
        {
            foreach (InvocationExpressionSyntax invocation in method.Flow.SelectMany((item) => item.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>()))
            {
                if (invocation.Expression.ToString() != "Mii.Unresolved" || invocation.ArgumentList.Arguments.Count != 1
                    || invocation.ArgumentList.Arguments[0].Expression is not LiteralExpressionSyntax literal)
                {
                    continue;
                }

                string reference = literal.Token.ValueText;
                int dot = reference.IndexOf('.');

                if (dot < 0 || !queryActions.TryGetValue(reference.Substring(0, dot), out ActionContext action)
                    || !FormatDefaults.TryGetValue(reference.Substring(dot + 1), out string fallback))
                {
                    continue;
                }

                string name = reference.Substring(dot + 1);
                (string Name, string Value, bool Linked) configured = action.Settings.FirstOrDefault((item) => item.Name == name);
                string value = configured.Name != null && configured.Value.Length > 0 ? configured.Value : "";

                if (value.Length == 0 && file.Templates.TryGetValue(action.Setting("QueryTemplate").Trim(), out Template template))
                {
                    value = template.Setting(name);
                }

                file.Replace(invocation.Span, Comments.Literal(value.Length > 0 ? value : fallback));
            }
        }

        /// <summary>C# name and type of each Transaction.X, Local.X and "action X" of the method.</summary>
        private readonly Dictionary<string, (string Name, string Type)> variablesByKey = [];

        /// <summary>Append XML of Doc{xpath}: the default file reads the text of the first node (Mii.XPath); MII appends
        /// the selected nodes. A stylesheet the file does not hold goes through frame.LoadResource (a clear error).</summary>
        private void ConvertXmlSources()
        {
            foreach (InvocationExpressionSyntax invocation in method.Flow.SelectMany((item) => item.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>()))
            {
                string called = invocation.Expression.ToString();

                if ((called == "Mii.AppendXml" || called == "Mii.AppendAfterXml") && invocation.ArgumentList.Arguments.Count == 3
                    && invocation.ArgumentList.Arguments[2].Expression is InvocationExpressionSyntax source && source.Expression.ToString() == "Mii.XPath")
                {
                    file.Replace(source.Expression.Span, "Mii.SelectNodes");
                }

                if (called == "plugins.LoadResource")
                {
                    file.Replace(invocation.Expression.Span, frame + ".LoadResource");
                }
            }
        }

        private readonly HashSet<ForEachStatementSyntax> keptLoops = [];

        private static readonly Regex DynamicReference = new Regex(@"#([A-Za-z_]\w*)\.([A-Za-z_]\w*)(?:\{[^{}#]*\}|\{\{[^{}#]*\}\})?#");

        /// <summary>#Transaction.X#, #Local.X#, #Action.Property#, #Repeater.Item{xpath}#, #Iterator.CurrentItem# in a
        /// literal (XPath, regular expression, text): MII puts the value in at runtime (MiiSim.Dynamic).</summary>
        private void WrapDynamicLiterals()
        {
            foreach (ExpressionSyntax literal in method.Flow.SelectMany((item) => item.DescendantNodesAndSelf())
                .Where((node) => node.IsKind(SyntaxKind.StringLiteralExpression) || node is InterpolatedStringExpressionSyntax).Cast<ExpressionSyntax>())
            {
                if (literal.Ancestors().Any((node) => node is InterpolatedStringExpressionSyntax)
                    || (literal.Parent is ArgumentSyntax argument && argument.Parent?.Parent is InvocationExpressionSyntax owner
                        && (owner.Expression.ToString() == "Mii.Unresolved" || owner.Expression.ToString() == "Mii.Evaluate")))
                {
                    continue;
                }

                List<string> values = [];

                foreach (Match match in DynamicReference.Matches(literal.ToString()))
                {
                    string key = match.Groups[1].Value + "." + match.Groups[2].Value;
                    string code = DynamicValue(literal, match.Groups[1].Value, match.Groups[2].Value);
                    string pair = code == null ? null : "(" + Comments.Literal(key) + ", (object)" + code + ")";

                    if (pair != null && !values.Contains(pair))
                    {
                        values.Add(pair);
                    }
                }

                if (values.Count > 0)
                {
                    file.Insert(literal.SpanStart, "MiiSim.Dynamic(", 105);
                    file.Insert(literal.Span.End, ", " + string.Join(", ", values) + ")", 5);
                }
            }
        }

        /// <summary>The C# value of Scope.Member at a literal: a transaction property or local, an action's result (its
        /// member is resolved at runtime), the item of an enclosing loop; null when unknown.</summary>
        private string DynamicValue(SyntaxNode at, string scope, string member)
        {
            if (scope == "Transaction" || scope == "Local")
            {
                return variablesByKey.TryGetValue(scope + "." + member, out (string Name, string Type) variable) ? variable.Name : null;
            }

            // an enclosing loop (foreach over the items, the item variable is <loop>Item)
            ForEachStatementSyntax loop = at.Ancestors().OfType<ForEachStatementSyntax>()
                .FirstOrDefault((item) => Simple(item.Identifier.ValueText) == Simple(scope + "Item"));

            if (loop != null)
            {
                return member == "Item" || member == "Output" || member == "CurrentItem" ? loop.Identifier.Text : null;
            }

            // a loop of the method that has ended: MII keeps its last item (frame.LoopItem, "Invalid variable" before)
            ForEachStatementSyntax ended = method.Flow.SelectMany((item) => item.DescendantNodesAndSelf()).OfType<ForEachStatementSyntax>()
                .FirstOrDefault((item) => Simple(item.Identifier.ValueText) == Simple(scope + "Item"));

            if (ended != null && ended.Statement is BlockSyntax body && (member == "Item" || member == "Output" || member == "CurrentItem"))
            {
                if (keptLoops.Add(ended))
                {
                    file.Insert(body.OpenBraceToken.Span.End, " " + frame + ".KeepLoopItem(" + Comments.Literal(scope) + ", " + ended.Identifier.Text + ");", 100);
                }

                return frame + ".LoopItem(" + Comments.Literal(scope) + ")";
            }

            KeyValuePair<string, string> action = actionVariables.FirstOrDefault((pair) => pair.Value == scope);
            return action.Key != null ? frame + ".Read(" + Comments.Literal(scope) + ", " + action.Key + ")" : null;
        }

        /// <summary>A configured setting of a plugin action that MII evaluates as a reference (Distinct ValueSource,
        /// GenericSortFilter Source): the C# value, or null when the reference is not one of this method.</summary>
        public string ReferenceCode(string reference)
        {
            Match match = Regex.Match(reference.Trim(), @"^([A-Za-z_]\w*)\.([A-Za-z_]\w*)(?:\{(.*)\})?$", RegexOptions.Singleline);

            if (!match.Success)
            {
                return null;
            }

            string scope = match.Groups[1].Value;
            string member = match.Groups[2].Value;
            string code = null;

            if ((scope == "Transaction" || scope == "Local") && variablesByKey.TryGetValue(scope + "." + member, out (string Name, string Type) variable))
            {
                code = variable.Name;
            }
            else
            {
                KeyValuePair<string, string> action = actionVariables.FirstOrDefault((pair) => pair.Value == scope);

                if (action.Key != null && variablesByKey.TryGetValue("action " + scope, out (string Name, string Type) result))
                {
                    code = frame + ".Read(" + Comments.Literal(scope) + ", " + action.Key + ")" + (result.Type == "PluginResult" ? ".Get(" + Comments.Literal(member) + ")" : "");
                }
            }

            if (code == null)
            {
                return null;
            }

            return match.Groups[3].Success ? "MiiSim.Nodes(" + code + ", " + Comments.Literal(match.Groups[3].Value.Trim()) + ")" : code;
        }

        /// <summary>Patterns of the Regex calls the X-Ray writes for match() are Java patterns: Mii.JavaPattern.</summary>
        private void WrapRegexPatterns()
        {
            foreach (InvocationExpressionSyntax invocation in method.Flow.SelectMany((item) => item.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>()))
            {
                if (invocation.Expression is MemberAccessExpressionSyntax member && member.Expression.ToString() == "Regex"
                    && invocation.ArgumentList.Arguments.Count >= 2)
                {
                    ExpressionSyntax pattern = invocation.ArgumentList.Arguments[1].Expression;
                    file.Insert(pattern.SpanStart, "Mii.JavaPattern(", 104);
                    file.Insert(pattern.Span.End, ")", 6);
                }
            }
        }

        private void ConvertLeaf(StatementSyntax statement, ActionContext context)
        {
            if (file.ConvertQueryStatement(statement, TemplateOf(statement, context), frame, context.Name, context))
            {
                return;
            }

            string target = null;
            ExpressionSyntax value;
            int start;
            int end;

            if (statement is LocalDeclarationStatementSyntax local)
            {
                if (!hoistedStatements.Contains(local))
                {
                    return;
                }

                VariableDeclaratorSyntax variable = local.Declaration.Variables[0];
                target = variable.Identifier.Text;
                value = variable.Initializer.Value;
                start = local.Declaration.SpanStart;
                end = value.Span.End;
                file.ReplaceRange(start, value.SpanStart, target + " = ");
            }
            else
            {
                ExpressionSyntax expression = ((ExpressionStatementSyntax)statement).Expression;
                start = expression.SpanStart;
                end = expression.Span.End;
                value = expression;

                if (expression is AssignmentExpressionSyntax assignment && assignment.IsKind(SyntaxKind.SimpleAssignmentExpression))
                {
                    value = assignment.Right;
                    target = assignment.Left is IdentifierNameSyntax name ? name.Identifier.Text : null;

                    if (target == null)
                    {
                        target = "";
                    }
                }
            }

            string resultOf = target != null && actionVariables.TryGetValue(target, out string owner) ? owner : null;
            InvocationExpressionSyntax invocation = value as InvocationExpressionSyntax;

            // a transaction of this file
            if (invocation != null && invocation.Expression is IdentifierNameSyntax called && file.Methods.TryGetValue(called.Identifier.Text, out MethodInfo callee) && !callee.IsQueryMethod)
            {
                string actionName = resultOf ?? context.Name;
                Wrap(start, end, frame + ".Transaction(" + Comments.Literal(actionName) + ", " + Bool(context.IsTrue("ResetState")) + ", "
                    + Bool(context.Async || context.IsTrue("Async")) + ", " + Bool(context.Xacute) + ", () => ");

                foreach (ArgumentSyntax argument in invocation.ArgumentList.Arguments.Where((item) => item.NameColon != null))
                {
                    Parameter parameter = callee.Parameters.FirstOrDefault((item) => item.Name == argument.NameColon.Name.Identifier.Text);

                    if (parameter == null)
                    {
                        continue;
                    }

                    file.Insert(argument.Expression.SpanStart, frame + ".Arg<" + parameter.Type + ">(" + Comments.Literal(MiiName(parameter)) + ", () => ", 102);
                    file.Insert(argument.Expression.Span.End, ")", 8);
                    file.Strict(argument.Expression);
                }

                return;
            }

            // a query
            if (invocation != null && invocation.Expression is MemberAccessExpressionSyntax queryCall && queryCall.Expression.ToString() == "queries")
            {
                Wrap(start, end, frame + ".Action(" + Comments.Literal(resultOf ?? context.Name) + ", " + Comments.Literal(context.Type ?? "Query") + ", () => ");
                return;
            }

            // a plugin action (or a transaction call the file cannot resolve)
            if (invocation != null && invocation.Expression is MemberAccessExpressionSyntax pluginCall && pluginCall.Expression.ToString() == "plugins"
                && pluginCall.Name.Identifier.Text == "Invoke" && invocation.ArgumentList.Arguments.Count == 3)
            {
                ConvertPluginCall(invocation, context, resultOf, start, end);
                return;
            }

            if (resultOf != null)
            {
                Wrap(start, end, frame + ".Action(" + Comments.Literal(resultOf) + ", " + Comments.Literal(context.Type ?? "Action") + ", () => ");
                file.Strict(value);
                return;
            }

            if (invocation != null && invocation.Expression is MemberAccessExpressionSyntax log && log.Expression.ToString() == "plugins" && log.Name.Identifier.Text == "Log"
                && invocation.ArgumentList.Arguments.Count == 2)
            {
                file.WrapIncoming(frame, invocation.ArgumentList.Arguments[1].Expression, "string", context.Name + ".Message", "\"\"");
                return;
            }

            if (invocation != null && invocation.Expression.ToString() == "Thread.Sleep")
            {
                return;
            }

            if (target != null)
            {
                // an outgoing link (or a link of an Assignment)
                bool strict = file.Strict(value);

                if (strict || file.CanFail(value))
                {
                    Wrap(start, end, frame + ".Link(" + Comments.Literal(context.Name) + ", () => ");
                }

                return;
            }

            if (invocation != null)
            {
                Wrap(start, end, frame + ".Link(" + Comments.Literal(context.Name) + ", () => ");
            }
        }

        private void ConvertPluginCall(InvocationExpressionSyntax invocation, ActionContext context, string resultOf, int start, int end)
        {
            SeparatedSyntaxList<ArgumentSyntax> arguments = invocation.ArgumentList.Arguments;
            string actionType = arguments[0].Expression is LiteralExpressionSyntax typeLiteral ? typeLiteral.Token.ValueText : "";
            string actionName = arguments[1].Expression is LiteralExpressionSyntax nameLiteral ? nameLiteral.Token.ValueText : context.Name;
            ExpressionSyntax settings = arguments[2].Expression;
            List<string> configured = [];

            if (context.Name == actionName)
            {
                foreach ((string name, string value, bool linked) in context.Settings)
                {
                    if (!linked)
                    {
                        configured.Add("[" + Comments.Literal(name) + "] = " + Comments.Literal(value));
                    }
                }
            }

            string configuredCode = configured.Count == 0 ? "new Dictionary<string, object>()"
                : "new Dictionary<string, object> { " + string.Join(", ", configured) + " }";

            if (settings is ImplicitObjectCreationExpressionSyntax creation && creation.Initializer != null)
            {
                foreach (AssignmentExpressionSyntax entry in creation.Initializer.Expressions.OfType<AssignmentExpressionSyntax>())
                {
                    string key = entry.Left is ImplicitElementAccessSyntax access && access.ArgumentList.Arguments.Count == 1
                        && access.ArgumentList.Arguments[0].Expression is LiteralExpressionSyntax keyLiteral ? keyLiteral.Token.ValueText : "?";
                    string reference = key.EndsWith("Source", StringComparison.Ordinal) && entry.Right is LiteralExpressionSyntax configuredReference
                        ? ReferenceCode(configuredReference.Token.ValueText) : null;

                    if (reference != null)
                    {
                        // MII evaluates the configured reference (Local.X{/path}, Action.Output) when the action runs
                        file.Replace(entry.Right.Span, reference);
                        continue;
                    }

                    file.WrapIncoming(frame, entry.Right, "object", actionName + "." + key, "null");
                }
            }

            if (actionType == "TransactionCall")
            {
                file.ReplaceRange(invocation.SpanStart, settings.SpanStart, frame + ".CallTransaction(" + Comments.Literal(actionName) + ", "
                    + Bool(context.Name == actionName && context.IsTrue("ResetState")) + ", " + configuredCode + ", ");
            }
            else
            {
                file.Insert(settings.SpanStart, "MiiSim.Settings(" + configuredCode + ", ", 103);
                file.Insert(settings.Span.End, ")", 7);
            }

            Wrap(start, end, frame + ".Action(" + Comments.Literal(resultOf ?? actionName) + ", " + Comments.Literal(actionType) + ", () => ");
        }

        /// <summary>The template of a query: the action's QueryTemplate setting, else the header entry of the variable.</summary>
        private string TemplateOf(StatementSyntax statement, ActionContext context)
        {
            string configured = context.Setting("QueryTemplate");

            if (!string.IsNullOrWhiteSpace(configured))
            {
                return configured.Trim();
            }

            if (statement is LocalDeclarationStatementSyntax local && local.Declaration.Variables.Count == 1)
            {
                string variable = Simple(local.Declaration.Variables[0].Identifier.Text);

                foreach (Template template in file.Templates.Values)
                {
                    string leaf = Simple(template.Path.Substring(template.Path.LastIndexOf('/') + 1));

                    if (variable == leaf || (variable.StartsWith(leaf) && variable.Substring(leaf.Length).All(char.IsDigit)))
                    {
                        return template.Path;
                    }
                }
            }

            return "";
        }

        private static string Simple(string name) => new string(name.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

        private void Wrap(int start, int end, string opening)
        {
            file.Insert(start, opening, 101);
            file.Insert(end, ")", 9);
        }

        private static string Bool(bool value) => value ? "true" : "false";
    }
}

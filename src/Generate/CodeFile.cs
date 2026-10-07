using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using MiiXRay.Model;
using MiiXRay.Resolve;

namespace MiiXRay.Generate
{
    /// <summary>The result of one X-Ray run.</summary>
    public sealed class XRayResult
    {
        public string Code;
        public string RootClassName;
        public int TransactionCount;
        public int QueryCount;
        public List<string> Missing = new List<string>();
        public List<string> Notes = new List<string>();
    }

    /// <summary>Assembles the generated file (C# 12): header, the logic class with one method per transaction, the
    /// records (results and rows), the service interfaces and the runtime.</summary>
    public static class CodeFile
    {
        public const string ToolVersion = "2.0.0";

        public static XRayResult Generate(ObjectGraph graph, string sourceDescription)
        {
            GenerationContext context = new GenerationContext(graph);
            ContractBuilder.Build(context);

            // methods first: they complete the row records (columns read by XPath)
            List<string> methods = new List<string>();

            foreach (MiiTransaction transaction in graph.Transactions)
            {
                TransactionContract contract = context.Transactions[transaction];
                methods.Add(string.Empty);
                methods.AddRange(new TransactionEmitter(context, contract).EmitMethod(transaction == graph.Root));
            }

            TransactionContract root = context.Transactions[graph.Root];
            List<string> lines = new List<string>();
            lines.AddRange(Header(context, root, sourceDescription));
            lines.Add("#nullable disable");
            lines.Add(string.Empty);
            lines.Add("using System;");
            lines.Add("using System.Collections.Generic;");
            lines.Add("using System.Globalization;");
            lines.Add("using System.IO;");
            lines.Add("using System.Linq;");
            lines.Add("using System.Reflection;");
            lines.Add("using System.Text;");
            lines.Add("using System.Text.RegularExpressions;");
            lines.Add("using System.Threading;");
            lines.Add("using System.Xml;");
            lines.Add("using System.Xml.Xsl;");
            lines.Add(string.Empty);
            lines.Add("namespace XRay." + root.MethodName + ";");
            lines.Add(string.Empty);
            lines.Add("/// <summary>");
            lines.Add("/// The logic of " + XmlText(root.Transaction.Path) + " and of every transaction it calls, one method each.");
            lines.Add("/// </summary>");
            lines.Add("public sealed class " + context.ClassName + "(IQueryService queries, IPluginService plugins)");
            lines.Add("{");
            methods.RemoveAt(0);
            lines.AddRange(TransactionEmitter.Indent(methods));
            lines.Add("}");
            lines.AddRange(Records(context));
            lines.Add(string.Empty);
            lines.AddRange(ResourceLines("MiiXRay.RuntimeSource.txt"));

            string text = string.Join("\n", CodeLayout.AddBlankLines(lines).ToArray()).Replace("\r\n", "\n");
            XRayResult result = new XRayResult();
            result.Code = text.Replace("\n", Environment.NewLine) + Environment.NewLine;
            result.RootClassName = root.MethodName;
            result.TransactionCount = graph.Transactions.Count;
            result.QueryCount = graph.Queries.Count;
            result.Missing.AddRange(graph.Missing);
            result.Notes.AddRange(context.Notes);
            return result;
        }

        private static List<string> Header(GenerationContext context, TransactionContract root, string sourceDescription)
        {
            List<string> lines = new List<string>();
            string rule = "// " + new string('=', 110);
            lines.Add(rule);
            lines.Add("// MII X-Ray of " + root.Transaction.Path);
            lines.Add("// Generated " + DateTime.Now.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) + " by MII X-Ray " + ToolVersion + " from " + sourceDescription);
            lines.Add("//");
            lines.Add("// The logic of the transaction and of every transaction and query it uses, as C# 12 (.NET 8). It shows what the");
            lines.Add("// code does, not how MII runs it: MII runtime settings and default values are left out, a called transaction is a");
            lines.Add("// method, a query goes through IQueryService, an MII action without a C# equivalent through IPluginService.");
            lines.Add("// The Mii class at the end implements the MII expression functions and the XML handling.");
            lines.Add("//");
            lines.Add("// Entry point: new " + context.ClassName + "(queries, plugins)." + root.MethodName + "(...)");
            lines.Add("//");
            lines.AddRange(ReadingRules());
            lines.Add("//");
            lines.Add("// Transactions (" + context.Graph.Transactions.Count + "):");

            foreach (MiiTransaction transaction in context.Graph.Transactions)
            {
                lines.Add("//   " + context.Transactions[transaction].MethodName + " = " + transaction.Path);
            }

            lines.Add("//");
            lines.Add("// Call tree (execution order; [if X], [else X], [case n of X], [loop X] = once per item, [on error X] = in the handler of the catch X):");
            lines.Add("//   " + root.MethodName);
            CallTree(root, "//     ", new List<TransactionContract>(), lines);

            if (context.Graph.Queries.Count > 0)
            {
                lines.Add("//");
                lines.Add("// Queries (" + context.Graph.Queries.Count + "):");

                foreach (MiiQuery query in context.Graph.Queries)
                {
                    lines.AddRange(QueryOverview(context.Queries[query]));
                }
            }

            if (context.Graph.Missing.Count > 0)
            {
                lines.Add("//");
                lines.Add("// Not found (called through IPluginService instead):");

                foreach (string missing in context.Graph.Missing)
                {
                    lines.Add("//   " + missing);
                }
            }

            if (context.Notes.Count > 0)
            {
                lines.Add("//");
                lines.Add("// Notes (" + context.Notes.Count + "):");

                foreach (string note in context.Notes)
                {
                    lines.Add("//   " + note);
                }
            }

            lines.Add(rule);
            lines.Add(string.Empty);
            return lines;
        }

        private static List<string> ReadingRules()
        {
            List<string> lines = new List<string>();
            lines.Add("// How to read this file:");
            lines.Add("//   - Every MII transaction is a method: its parameters are the MII inputs, its return value the MII outputs (a");
            lines.Add("//     record when there are several). A caller passes the inputs it links; MII default values are not carried over.");
            lines.Add("//   - A query is a local Query variable: its text is the MII template text, AddParameter(name, value) sets a parameter;");
            lines.Add("//     the comment above it maps [Param.N] to the names. MII replaces [Param.N] by the value as text, there are no");
            lines.Add("//     bind variables; quoting and escaping are done by the callers (e.g. Mii.StringReplace(x, \"'\", \"''\")).");
            lines.Add("//   - MII rowset documents are lists of row records; FirstOrEmpty() and RowAt(n) give an empty row instead of null.");
            lines.Add("//   - A catch handles every action before it in the same block (MII Catch). TransactionTerminatedException is");
            lines.Add("//     MII's Terminate Transaction: it ends the transaction, its own catch blocks pass it on to the caller.");
            lines.Add("//   - Mii.IsEmpty(x) is MII's empty check (blank, \"null\" or \"---\"), Mii.IsTrue(x) its boolean check (\"true\" or \"1\").");
            lines.Add("//   - Improvements must keep the interfaces and the behaviour (sorting, empty checks, returned values) unless a");
            lines.Add("//     change is asked for; list every behaviour change separately.");
            lines.Add("//   - The notes below are problems of the MII objects themselves (stale links, undeclared properties); the code");
            lines.Add("//     keeps them as they are.");
            return lines;
        }

        /// <summary>The calls of a transaction, recursively; a transaction already shown is not expanded again.</summary>
        private static void CallTree(TransactionContract contract, string indent, List<TransactionContract> expanded, List<string> lines)
        {
            expanded.Add(contract);

            foreach (OutlineEntry entry in contract.Outline)
            {
                string flow = entry.Flow.Length > 0 ? "  [" + entry.Flow + "]" : string.Empty;
                string action = " (" + entry.ActionName + ")";

                if (entry.Kind == "call" && entry.Callee != null && expanded.Contains(entry.Callee))
                {
                    lines.Add(indent + "call   " + entry.Target + action + flow + "  - shown above");
                    continue;
                }

                lines.Add(indent + entry.Kind.PadRight(6) + " " + entry.Target + action + flow);

                if (entry.Kind == "call" && entry.Callee != null)
                {
                    CallTree(entry.Callee, indent + "    ", expanded, lines);
                }
            }
        }

        private static List<string> QueryOverview(QueryContract contract)
        {
            MiiQuery query = contract.Query;
            List<string> lines = new List<string>();
            string kind = query.Kind == MiiQueryKind.Xacute ? "Xacute query, runs its transaction"
                : query.Kind == MiiQueryKind.Xml ? "XML query, via IPluginService" : query.RootName + " " + query.Mode;
            lines.Add("//   " + query.ShortName + " = " + query.Path + " (" + kind + ")");

            if (contract.Parameters.Count > 0)
            {
                List<string> parameters = new List<string>();

                foreach (QueryParameterSpec parameter in contract.Parameters)
                {
                    parameters.Add("[Param." + parameter.Slot.ToString(CultureInfo.InvariantCulture) + "] " + parameter.Name);
                }

                lines.Add("//     parameters: " + string.Join(", ", parameters.ToArray()));
            }

            lines.Add("//     run by: " + (contract.Callers.Count > 0 ? string.Join("; ", contract.Callers.ToArray()) : "(no action of these transactions)"));

            if (contract.Result != null)
            {
                List<string> read = new List<string>();
                List<string> unread = new List<string>();

                foreach (RowsetColumn column in contract.Result.Columns)
                {
                    (column.Read ? read : unread).Add(column.Name);
                }

                lines.Add("//     columns read by name: " + (read.Count > 0 ? string.Join(", ", read.ToArray()) : "none"));

                if (unread.Count > 0)
                {
                    lines.Add("//     columns not read by name: " + string.Join(", ", unread.ToArray())
                        + (contract.Result.PassedOnWhole ? " (the result is also passed on as a whole, so they may be used further on)" : string.Empty));
                }
            }

            return lines;
        }

        // ------------------------------------------------------------------ records

        private static List<string> Records(GenerationContext context)
        {
            List<string> lines = new List<string>();

            foreach (MiiTransaction transaction in context.Graph.Transactions)
            {
                TransactionContract contract = context.Transactions[transaction];

                if (contract.ResultRecordName == null)
                {
                    continue;
                }

                List<string> members = new List<string>();

                foreach (PropertySpec output in contract.Outputs)
                {
                    members.Add(output.Type.Name + " " + output.ResultName);
                }

                lines.Add(string.Empty);
                lines.Add("/// <summary>The outputs of " + XmlText(transaction.Path) + ".</summary>");
                lines.Add("public sealed record " + contract.ResultRecordName + "(" + string.Join(", ", members.ToArray()) + ");");
            }

            foreach (RowsetContract contract in context.Contracts)
            {
                lines.Add(string.Empty);
                lines.AddRange(RowRecord(contract));
            }

            return lines;
        }

        private static List<string> RowRecord(RowsetContract contract)
        {
            List<string> lines = new List<string>();
            lines.Add("/// <summary>A row of an MII rowset document (" + XmlText(contract.Origin) + ").</summary>");
            lines.Add("public sealed record " + contract.RowClass + " : MiiRow");
            lines.Add("{");
            List<string> body = new List<string>();

            foreach (RowsetColumn column in contract.Columns)
            {
                if (column.PropertyName != column.Name)
                {
                    body.Add("/// <summary>Column " + XmlText(column.Name) + ".</summary>");
                }

                body.Add("public " + column.Type.Name + " " + column.PropertyName + " { get; set; }" + (column.Type.Kind == TypeKind.String ? " = \"\";" : string.Empty));
            }

            lines.AddRange(TransactionEmitter.Indent(body));
            lines.Add("}");
            return lines;
        }

        // ------------------------------------------------------------------ helpers

        private static List<string> ResourceLines(string name)
        {
            Assembly assembly = typeof(CodeFile).Assembly;

            using (Stream stream = assembly.GetManifestResourceStream(name))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException("The embedded resource " + name + " is missing (build problem).");
                }

                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                {
                    return new List<string>(SplitLines(reader.ReadToEnd().TrimEnd()));
                }
            }
        }

        private static string[] SplitLines(string text)
        {
            return text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        }

        private static string XmlText(string text)
        {
            return (text ?? string.Empty).Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
        }
    }
}

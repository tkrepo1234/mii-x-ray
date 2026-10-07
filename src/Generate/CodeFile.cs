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

    /// <summary>Assembles the generated file: header, transaction classes, query classes, service interfaces and the runtime.</summary>
    public static class CodeFile
    {
        public const string ToolVersion = "1.0.0";

        public static XRayResult Generate(ObjectGraph graph, string sourceDescription)
        {
            GenerationContext context = new GenerationContext(graph);
            ContractBuilder.Build(context);

            // bodies first: they complete the rowset contracts (columns read by XPath)
            Dictionary<TransactionContract, List<string>> methods = new Dictionary<TransactionContract, List<string>>();

            foreach (MiiTransaction transaction in graph.Transactions)
            {
                TransactionContract contract = context.Transactions[transaction];
                methods[contract] = new TransactionEmitter(context, contract).EmitExecuteMethod();
            }

            TransactionContract root = context.Transactions[graph.Root];
            List<string> lines = new List<string>();
            lines.AddRange(Header(context, root, sourceDescription));
            lines.Add("using System;");
            lines.Add("using System.Collections.Generic;");
            lines.Add("using System.Globalization;");
            lines.Add("using System.IO;");
            lines.Add("using System.Reflection;");
            lines.Add("using System.Text;");
            lines.Add("using System.Text.RegularExpressions;");
            lines.Add("using System.Threading;");
            lines.Add("using System.Xml;");
            lines.Add("using System.Xml.Xsl;");
            lines.Add(string.Empty);
            lines.Add("namespace XRay." + root.ClassName + "Logic");
            lines.Add("{");
            List<string> body = new List<string>();
            body.Add("#region Transactions");

            foreach (MiiTransaction transaction in graph.Transactions)
            {
                TransactionContract contract = context.Transactions[transaction];
                body.Add(string.Empty);
                body.AddRange(TransactionClass(contract, methods[contract]));
            }

            body.Add(string.Empty);
            body.Add("#endregion");
            List<QueryContract> queries = QueryClasses(context);

            if (queries.Count > 0)
            {
                body.Add(string.Empty);
                body.Add("#region Queries");

                foreach (QueryContract query in queries)
                {
                    body.Add(string.Empty);
                    body.AddRange(QueryClass(query));
                }

                body.Add(string.Empty);
                body.Add("#endregion");
            }

            body.Add(string.Empty);
            body.AddRange(ResourceLines("MiiXRay.RuntimeSource.txt"));
            lines.AddRange(TransactionEmitter.Indent(body));
            lines.Add("}");

            XRayResult result = new XRayResult();
            result.Code = string.Join(Environment.NewLine, CodeLayout.AddBlankLines(lines).ToArray()) + Environment.NewLine;
            result.RootClassName = root.ClassName;
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
            lines.Add("// The logic of the transaction and of every transaction and query it uses, as plain C# (C# 5, .NET Framework 4.8).");
            lines.Add("// It shows what the code does, not how MII runs it: MII runtime settings are left out, a called transaction is a");
            lines.Add("// static method, a query goes through IQueryService, an MII action without a C# equivalent through IPluginService.");
            lines.Add("// The Mii class at the end stands in for the MII expression functions and the XML handling.");
            lines.Add("//");
            lines.Add("// Entry point: " + root.ClassName + ".Execute(request, queryService, pluginService)");
            lines.Add("//");
            lines.Add("// Transactions (" + context.Graph.Transactions.Count + "):");

            foreach (MiiTransaction transaction in context.Graph.Transactions)
            {
                lines.Add("//   " + context.Transactions[transaction].ClassName + " = " + transaction.Path);
            }

            if (context.Graph.Queries.Count > 0)
            {
                lines.Add("// Queries (" + context.Graph.Queries.Count + "):");

                foreach (MiiQuery query in context.Graph.Queries)
                {
                    QueryContract contract = context.Queries[query];
                    string kind = query.Kind == MiiQueryKind.Xacute ? "Xacute query, runs its transaction"
                        : query.Kind == MiiQueryKind.Xml ? "XML query, via IPluginService" : query.RootName + " " + query.Mode;
                    lines.Add("//   " + contract.ClassName + " = " + query.Path + " (" + kind + ")");
                }
            }

            if (context.Graph.Missing.Count > 0)
            {
                lines.Add("// Not found (called through IPluginService instead):");

                foreach (string missing in context.Graph.Missing)
                {
                    lines.Add("//   " + missing);
                }
            }

            if (context.Notes.Count > 0)
            {
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

        // ------------------------------------------------------------------ transactions

        private static List<string> TransactionClass(TransactionContract contract, List<string> method)
        {
            List<string> lines = new List<string>();
            lines.Add("/// <summary>");
            lines.Add("/// " + XmlText(contract.Transaction.Path));

            if (contract.Transaction.Description.Length > 0)
            {
                foreach (string line in SplitLines(contract.Transaction.Description))
                {
                    lines.Add("/// " + XmlText(line));
                }
            }

            lines.Add("/// </summary>");
            lines.Add("public static class " + contract.ClassName);
            lines.Add("{");
            List<string> body = new List<string>();
            body.Add("public const string TransactionPath = " + CsLiteral.String(contract.Transaction.Path) + ";");
            body.Add(string.Empty);
            body.AddRange(PropertyClass("Request", "The inputs of the transaction (defaults as configured in MII).", contract.RequestProperties));
            body.Add(string.Empty);
            body.AddRange(PropertyClass("Response", "The outputs of the transaction.", contract.ResponseProperties));

            foreach (RowsetContract rowset in contract.NestedContracts)
            {
                body.Add(string.Empty);
                body.AddRange(RowsetClasses(rowset));
            }

            body.Add(string.Empty);
            body.AddRange(method);
            lines.AddRange(TransactionEmitter.Indent(body));
            lines.Add("}");
            return lines;
        }

        private static List<string> PropertyClass(string name, string summary, List<PropertySpec> properties)
        {
            List<string> lines = new List<string>();
            lines.Add("/// <summary>" + summary + "</summary>");
            lines.Add("public sealed class " + name);
            lines.Add("{");
            List<string> body = new List<string>();
            body.Add("public " + name + "()");
            body.Add("{");

            foreach (PropertySpec property in properties)
            {
                body.Add("    " + property.Name + " = " + property.Initializer + ";");
            }

            body.Add("}");

            foreach (PropertySpec property in properties)
            {
                body.Add(string.Empty);

                if (property.Description.Length > 0)
                {
                    body.Add("/// <summary>" + XmlText(OneLine(property.Description)) + "</summary>");
                }

                body.Add("public " + property.Type.Name + " " + property.Name + " { get; set; }");
            }

            lines.AddRange(TransactionEmitter.Indent(body));
            lines.Add("}");
            return lines;
        }

        private static List<string> RowsetClasses(RowsetContract contract)
        {
            List<string> lines = new List<string>();
            lines.Add("/// <summary>A row of " + contract.RowsetClass + " (" + XmlText(contract.Origin) + ").</summary>");
            lines.Add("public sealed class " + contract.RowClass + " : RowBase");
            lines.Add("{");
            List<string> body = new List<string>();
            body.Add("public " + contract.RowClass + "()");
            body.Add("{");

            foreach (RowsetColumn column in contract.Columns)
            {
                body.Add("    " + column.PropertyName + " = " + ContractBuilder.Initializer(column.Type, string.Empty) + ";");
            }

            body.Add("}");

            foreach (RowsetColumn column in contract.Columns)
            {
                body.Add(string.Empty);

                if (column.PropertyName != column.Name)
                {
                    body.Add("/// <summary>Column " + XmlText(column.Name) + ".</summary>");
                }

                body.Add("public " + column.Type.Name + " " + column.PropertyName + " { get; set; }");
            }

            lines.AddRange(TransactionEmitter.Indent(body));
            lines.Add("}");
            lines.Add(string.Empty);
            lines.Add("/// <summary>An MII rowset document (Rowsets/Rowset/Row) with rows of " + contract.RowClass + ".</summary>");
            lines.Add("public sealed class " + contract.RowsetClass + " : RowsetBase<" + contract.RowClass + ">");
            lines.Add("{");
            lines.Add("}");
            return lines;
        }

        // ------------------------------------------------------------------ queries

        private static List<QueryContract> QueryClasses(GenerationContext context)
        {
            List<QueryContract> result = new List<QueryContract>();

            foreach (MiiQuery query in context.Graph.Queries)
            {
                QueryContract contract = context.Queries[query];

                if (contract.Result != null)
                {
                    result.Add(contract);
                }
            }

            return result;
        }

        private static List<string> QueryClass(QueryContract contract)
        {
            MiiQuery query = contract.Query;
            List<string> lines = new List<string>();
            lines.Add("/// <summary>" + XmlText(query.Path) + " (" + query.RootName + ", mode " + XmlText(query.Mode) + ").</summary>");
            lines.Add("public static class " + contract.ClassName);
            lines.Add("{");
            List<string> body = new List<string>();
            body.Add("/// <summary>The statement; MII replaces [Param.N] by the parameter values as text before it runs.</summary>");
            body.Add("public const string Text = " + CsLiteral.String(query.Text) + ";");
            body.Add(string.Empty);
            body.AddRange(QueryRequestClass(contract));
            body.Add(string.Empty);
            body.AddRange(RowsetClasses(contract.Result));
            lines.AddRange(TransactionEmitter.Indent(body));
            lines.Add("}");
            return lines;
        }

        private static List<string> QueryRequestClass(QueryContract contract)
        {
            List<string> lines = new List<string>();
            lines.Add("/// <summary>The parameters of the query (defaults as configured in the template).</summary>");
            lines.Add("public sealed class Request : IQueryRequest");
            lines.Add("{");
            List<string> body = new List<string>();
            List<string> parameters = new List<string>();

            foreach (QueryParameterSpec parameter in contract.Parameters)
            {
                parameters.Add("string " + parameter.ArgumentName + " = " + CsLiteral.String(parameter.DefaultValue));
            }

            if (parameters.Count <= 2)
            {
                body.Add("public Request(" + string.Join(", ", parameters.ToArray()) + ")");
            }
            else
            {
                body.Add("public Request(");

                for (int index = 0; index < parameters.Count; index++)
                {
                    body.Add("    " + parameters[index] + (index < parameters.Count - 1 ? "," : ")"));
                }
            }

            body.Add("{");

            foreach (QueryParameterSpec parameter in contract.Parameters)
            {
                body.Add("    " + parameter.PropertyName + " = " + parameter.ArgumentName + ";");
            }

            body.Add("}");

            foreach (QueryParameterSpec parameter in contract.Parameters)
            {
                body.Add(string.Empty);
                string description = parameter.Description.Length > 0 && parameter.Description != parameter.PropertyName ? " " + XmlText(parameter.Description) : string.Empty;
                body.Add("/// <summary>[Param." + parameter.Slot.ToString(CultureInfo.InvariantCulture) + "]" + description + "</summary>");
                body.Add("public string " + parameter.PropertyName + " { get; set; }");
            }

            body.Add(string.Empty);
            body.Add("public IDictionary<string, string> GetParameters()");
            body.Add("{");
            body.Add("    Dictionary<string, string> parameters = new Dictionary<string, string>();");

            foreach (QueryParameterSpec parameter in contract.Parameters)
            {
                body.Add("    parameters.Add(\"Param." + parameter.Slot.ToString(CultureInfo.InvariantCulture) + "\", " + parameter.PropertyName + ");");
            }

            body.Add("    return parameters;");
            body.Add("}");
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

        private static string OneLine(string text)
        {
            return string.Join(" ", SplitLines(text)).Trim();
        }

        private static string XmlText(string text)
        {
            return (text ?? string.Empty).Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
        }
    }
}

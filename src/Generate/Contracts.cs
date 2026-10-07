using System;
using System.Collections.Generic;
using System.Xml;
using MiiXRay.Model;
using MiiXRay.Resolve;
using MiiXRay.Sources;

namespace MiiXRay.Generate
{
    /// <summary>An input (method parameter), an output or a local variable of a transaction method.</summary>
    public sealed class PropertySpec
    {
        public string MiiName;

        /// <summary>The C# name inside the method (camelCase).</summary>
        public string Name;

        /// <summary>For an output of a transaction with several outputs: the property of its result record (PascalCase).</summary>
        public string ResultName;
        public CsType Type;

        /// <summary>The initial value as C# code.</summary>
        public string Initializer;
        public string Description;
    }

    /// <summary>One transaction as a method: its name, parameters, outputs (return value) and locals.</summary>
    public sealed class TransactionContract
    {
        public MiiTransaction Transaction;
        public string MethodName;

        /// <summary>The record returned when the transaction has several outputs, else null.</summary>
        public string ResultRecordName;
        public List<PropertySpec> Inputs = new List<PropertySpec>();
        public List<PropertySpec> Outputs = new List<PropertySpec>();
        public List<PropertySpec> Locals = new List<PropertySpec>();

        /// <summary>Names inside the method (parameters, outputs, locals, action results).</summary>
        public UniqueNames LocalNames = new UniqueNames();

        /// <summary>The calls, queries and plugin actions of the transaction in execution order (for the call tree).</summary>
        public List<OutlineEntry> Outline = new List<OutlineEntry>();

        public PropertySpec FindInput(string miiName)
        {
            return Find(Inputs, miiName);
        }

        public PropertySpec FindOutput(string miiName)
        {
            return Find(Outputs, miiName);
        }

        public PropertySpec FindLocal(string miiName)
        {
            return Find(Locals, miiName);
        }

        /// <summary>The C# return type: void, the type of the only output or the result record.</summary>
        public string ReturnTypeName
        {
            get
            {
                if (Outputs.Count == 0)
                {
                    return "void";
                }

                return Outputs.Count == 1 ? Outputs[0].Type.Name : ResultRecordName;
            }
        }

        /// <summary>The type of a variable that holds the returned value (null for void).</summary>
        public CsType ReturnType
        {
            get
            {
                if (Outputs.Count == 0)
                {
                    return null;
                }

                return Outputs.Count == 1 ? Outputs[0].Type : CsType.Class(ResultRecordName);
            }
        }

        /// <summary>"return x;", "return new XResult(a, b);" or "return;".</summary>
        public string ReturnStatement
        {
            get
            {
                if (Outputs.Count == 0)
                {
                    return "return;";
                }

                if (Outputs.Count == 1)
                {
                    return "return " + Outputs[0].Name + ";";
                }

                List<string> values = new List<string>();

                foreach (PropertySpec output in Outputs)
                {
                    values.Add(output.Name);
                }

                return "return new " + ResultRecordName + "(" + string.Join(", ", values.ToArray()) + ");";
            }
        }

        /// <summary>An output of this transaction, read from the variable that holds the value a call returned.</summary>
        public TypedCode OutputOf(string variable, string miiName)
        {
            PropertySpec output = FindOutput(miiName);

            if (output == null)
            {
                return null;
            }

            return Outputs.Count == 1 ? TypedCode.Primary(variable, output.Type) : TypedCode.Primary(variable + "." + output.ResultName, output.Type);
        }

        private static PropertySpec Find(List<PropertySpec> list, string miiName)
        {
            foreach (PropertySpec property in list)
            {
                if (property.MiiName == miiName)
                {
                    return property;
                }
            }

            return null;
        }
    }

    /// <summary>One line of the call tree: a transaction call, a query or a plugin action.</summary>
    public sealed class OutlineEntry
    {
        /// <summary>call, query or plugin.</summary>
        public string Kind;
        public string Target;
        public string ActionName;

        /// <summary>The enclosing branches, loops and error handlers, outermost first: "if X > loop Y" ("" at top level).</summary>
        public string Flow;
        public TransactionContract Callee;
    }

    public sealed class QueryParameterSpec
    {
        public int Slot;

        /// <summary>The name used in AddParameter: the parameter description of the template, else ParamN.</summary>
        public string Name;
    }

    /// <summary>One query template: the name of its local variable, its parameters and its result rows.</summary>
    public sealed class QueryContract
    {
        public MiiQuery Query;

        /// <summary>The name of the local Query variable (camelCase of the template name).</summary>
        public string VariableName;
        public List<QueryParameterSpec> Parameters = new List<QueryParameterSpec>();
        public RowsetContract Result;

        /// <summary>For an Xacute query: the transaction it forwards to (null when not loaded).</summary>
        public TransactionContract XacuteTarget;

        /// <summary>"Method.ActionName [if X]" for every action that runs the query.</summary>
        public List<string> Callers = new List<string>();

        public QueryParameterSpec FindParameter(int slot)
        {
            foreach (QueryParameterSpec parameter in Parameters)
            {
                if (parameter.Slot == slot)
                {
                    return parameter;
                }
            }

            return null;
        }
    }

    /// <summary>Shared state of one generation run.</summary>
    public sealed class GenerationContext
    {
        public static readonly string[] RuntimeTypeNames =
        {
            "Mii", "MiiRow", "MiiRows", "Query", "IQueryService", "IPluginService", "PluginResult", "MiiException",
            "TransactionTerminatedException"
        };

        public ObjectGraph Graph;
        public Dictionary<MiiTransaction, TransactionContract> Transactions = new Dictionary<MiiTransaction, TransactionContract>();
        public Dictionary<MiiQuery, QueryContract> Queries = new Dictionary<MiiQuery, QueryContract>();

        /// <summary>Top-level type names (the logic class, records, row records, runtime types).</summary>
        public UniqueNames TypeNames = new UniqueNames();

        /// <summary>Method names inside the logic class.</summary>
        public UniqueNames MethodNames = new UniqueNames();
        public List<RowsetContract> Contracts = new List<RowsetContract>();
        public List<string> Notes = new List<string>();
        public string ClassName;

        public GenerationContext(ObjectGraph graph)
        {
            Graph = graph;

            foreach (string name in RuntimeTypeNames)
            {
                TypeNames.Reserve(name);
            }
        }

        public void Note(string where, string message)
        {
            string note = where + ": " + message;

            if (!Notes.Contains(note))
            {
                Notes.Add(note);
            }
        }

        public TransactionContract FindTransaction(string reference)
        {
            MiiTransaction transaction = Graph.FindTransaction(reference);
            TransactionContract contract;
            return transaction != null && Transactions.TryGetValue(transaction, out contract) ? contract : null;
        }

        public QueryContract FindQuery(string reference)
        {
            MiiQuery query = Graph.FindQuery(reference);
            QueryContract contract;
            return query != null && Queries.TryGetValue(query, out contract) ? contract : null;
        }

        /// <summary>A new row record.</summary>
        public RowsetContract CreateContract(string baseName, string origin)
        {
            RowsetContract contract = new RowsetContract(TypeNames.Claim(Naming.Pascal(baseName).TrimStart('@') + "Row"), origin);
            Contracts.Add(contract);
            return contract;
        }

        /// <summary>Returns an existing row record with the same columns (and drops the new one), or the new one.</summary>
        public RowsetContract ShareIdentical(RowsetContract contract)
        {
            if (contract.Columns.Count == 0)
            {
                return contract;
            }

            foreach (RowsetContract existing in Contracts)
            {
                if (existing != contract && existing.Signature == contract.Signature)
                {
                    Contracts.Remove(contract);
                    return existing;
                }
            }

            return contract;
        }
    }

    /// <summary>Builds the contracts (method names, parameters, outputs, locals, query parameters and result rows) of
    /// every object before any code is generated, so that callers can refer to their callees' types.</summary>
    public static class ContractBuilder
    {
        private static readonly string[] MethodScopeNames = { "queries", "plugins" };

        public static void Build(GenerationContext context)
        {
            context.ClassName = context.TypeNames.Claim(Naming.Pascal(context.Graph.Root.ShortName).TrimStart('@') + "Logic");

            foreach (MiiTransaction transaction in context.Graph.Transactions)
            {
                TransactionContract contract = new TransactionContract();
                contract.Transaction = transaction;
                contract.MethodName = ClaimName(context.MethodNames, transaction.Path);
                context.Transactions.Add(transaction, contract);
            }

            foreach (MiiQuery query in context.Graph.Queries)
            {
                QueryContract contract = new QueryContract();
                contract.Query = query;
                contract.VariableName = Naming.Camel(query.ShortName);
                context.Queries.Add(query, contract);
            }

            foreach (TransactionContract contract in context.Transactions.Values)
            {
                BuildInterface(context, contract);
            }

            foreach (QueryContract contract in context.Queries.Values)
            {
                BuildQuery(context, contract);
            }

            AddCachedQueryColumns(context);
        }

        private static string ClaimName(UniqueNames names, string path)
        {
            string name = Naming.Pascal(ObjectPath.Leaf(path)).TrimStart('@');

            if (names.IsUsed(name))
            {
                string folder = ObjectPath.Leaf(ObjectPath.Folder(path));

                if (folder.Length > 0)
                {
                    name = Naming.Pascal(folder).TrimStart('@') + name;
                }
            }

            return names.Claim(name);
        }

        private static void BuildInterface(GenerationContext context, TransactionContract contract)
        {
            MiiTransaction transaction = contract.Transaction;

            foreach (string reserved in MethodScopeNames)
            {
                contract.LocalNames.Reserve(reserved);
            }

            foreach (MiiParameter parameter in transaction.Inputs)
            {
                PropertySpec input = Property(context, contract, parameter);
                input.Initializer = "default";
                contract.Inputs.Add(input);
            }

            UniqueNames resultNames = new UniqueNames();

            foreach (MiiParameter parameter in transaction.Outputs)
            {
                PropertySpec output = Property(context, contract, parameter);
                output.ResultName = resultNames.Claim(Naming.Pascal(parameter.Name).TrimStart('@'));
                output.Initializer = EmptyValue(output.Type);
                contract.Outputs.Add(output);
            }

            if (contract.Outputs.Count > 1)
            {
                contract.ResultRecordName = context.TypeNames.Claim(contract.MethodName + "Result");
            }

            Dictionary<string, bool> written = WrittenLocals(transaction);

            foreach (MiiParameter parameter in transaction.Locals)
            {
                PropertySpec local = Property(context, contract, parameter);

                // a local the flow never writes is configuration (an XSLT, a map of options): it keeps its MII value
                bool configuration = !written.ContainsKey(parameter.Name) && local.Type.Kind != TypeKind.Rowset && parameter.DefaultText.Trim().Length > 0;
                local.Initializer = configuration
                    ? Initializer(local.Type, local.Type.Kind == TypeKind.Xml ? XmlSample.Shrink(parameter.DefaultText) : parameter.DefaultText)
                    : EmptyValue(local.Type);
                contract.Locals.Add(local);
            }
        }

        private static Dictionary<string, bool> WrittenLocals(MiiTransaction transaction)
        {
            Dictionary<string, bool> written = new Dictionary<string, bool>();

            foreach (MiiActionUse use in transaction.AllActionUses())
            {
                foreach (MiiLink link in use.Outgoing)
                {
                    if (link.To.StartsWith("Local.", StringComparison.Ordinal))
                    {
                        string name = link.To.Substring("Local.".Length);
                        int brace = name.IndexOf('{');
                        written[brace >= 0 ? name.Substring(0, brace) : name] = true;
                    }
                }
            }

            return written;
        }

        private static PropertySpec Property(GenerationContext context, TransactionContract contract, MiiParameter parameter)
        {
            PropertySpec property = new PropertySpec();
            property.MiiName = parameter.Name;
            property.Name = contract.LocalNames.Claim(Naming.Camel(parameter.Name));
            property.Description = parameter.Description;
            property.Type = TypeOf(context, contract, parameter);
            return property;
        }

        private static CsType TypeOf(GenerationContext context, TransactionContract contract, MiiParameter parameter)
        {
            switch (parameter.Type)
            {
                case "boolean":
                    return CsType.Bool;
                case "integer":
                case "short":
                case "byte":
                    return CsType.Int;
                case "long":
                    return CsType.Long;
                case "double":
                case "float":
                    return CsType.Double;
                case "dateTime":
                    return CsType.DateTime;
                case "list":
                    return CsType.List;
                case "map":
                    return CsType.Map;
                case "xml":
                case "resultSet":
                    return XmlTypeOf(context, contract, parameter);
                default:
                    return CsType.String;
            }
        }

        /// <summary>An xml property is typed by its reference document when that is an Illuminator rowset.</summary>
        private static CsType XmlTypeOf(GenerationContext context, TransactionContract contract, MiiParameter parameter)
        {
            string text = parameter.DefaultText;

            if (text.Trim().Length == 0 && parameter.ReferenceSource.StartsWith("Local.", StringComparison.Ordinal))
            {
                string localName = parameter.ReferenceSource.Substring("Local.".Length);

                foreach (MiiParameter local in contract.Transaction.Locals)
                {
                    if (local.Name == localName)
                    {
                        text = local.DefaultText;
                    }
                }
            }

            XmlDocument document = MiiXml.TryParse(text);

            if (document == null || document.DocumentElement == null || document.DocumentElement.LocalName != "Rowsets")
            {
                return CsType.Xml;
            }

            RowsetContract rowset = context.CreateContract(parameter.Name, "reference document of " + parameter.Name + " in " + contract.Transaction.Path);
            ContractFactory.AddColumnsFromRowsets(rowset, document);
            return CsType.RowsetOf(context.ShareIdentical(rowset));
        }

        /// <summary>The empty value of a type (MII default values are not carried over).</summary>
        public static string EmptyValue(CsType type)
        {
            switch (type.Kind)
            {
                case TypeKind.String:
                    return "\"\"";
                case TypeKind.Bool:
                    return "false";
                case TypeKind.Int:
                    return "0";
                case TypeKind.Long:
                    return "0L";
                case TypeKind.Double:
                    return "0.0";
                case TypeKind.Decimal:
                    return "0m";
                case TypeKind.DateTime:
                    return "DateTime.MinValue";
                case TypeKind.List:
                case TypeKind.Rowset:
                    return "[]";
                case TypeKind.Map:
                case TypeKind.Xml:
                case TypeKind.Row:
                    return "new()";
                default:
                    return "null";
            }
        }

        /// <summary>A configured MII value as C# code of the given type.</summary>
        public static string Initializer(CsType type, string defaultText)
        {
            switch (type.Kind)
            {
                case TypeKind.String:
                    return CsLiteral.String(defaultText ?? string.Empty);
                case TypeKind.Bool:
                    return CsLiteral.IsTrue(defaultText) ? "true" : "false";
                case TypeKind.Int:
                case TypeKind.Long:
                case TypeKind.Double:
                case TypeKind.Decimal:
                    return CsLiteral.Number(defaultText, type.Kind);
                case TypeKind.DateTime:
                    return CsLiteral.DateTimeValue(defaultText);
                case TypeKind.List:
                    return ValueLiteral.ListCode(defaultText);
                case TypeKind.Map:
                    return ValueLiteral.MapCode(defaultText);
                case TypeKind.Rowset:
                    return "new " + type.Name + "()";
                case TypeKind.Xml:
                    if (MiiXml.TryParse(defaultText) != null)
                    {
                        return "Mii.ParseXml(" + CsLiteral.String(defaultText.Trim()) + ")";
                    }

                    return "new XmlDocument()";
                default:
                    return "null";
            }
        }

        private static void BuildQuery(GenerationContext context, QueryContract contract)
        {
            MiiQuery query = contract.Query;
            UniqueNames names = new UniqueNames();

            foreach (MiiQueryParameter parameter in query.Parameters)
            {
                QueryParameterSpec spec = new QueryParameterSpec();
                spec.Slot = parameter.Slot;
                string baseName = parameter.Description.Length > 0 ? parameter.Description : "Param" + parameter.Slot;

                if (query.Kind == MiiQueryKind.Xacute && query.XacuteMappedTargets.ContainsKey(parameter.Slot))
                {
                    baseName = query.XacuteMappedTargets[parameter.Slot];
                }

                spec.Name = names.Claim(baseName);
                contract.Parameters.Add(spec);
            }

            if (query.Kind == MiiQueryKind.Sql || query.Kind == MiiQueryKind.Mdo)
            {
                contract.Result = context.CreateContract(query.ShortName, "columns of " + query.Path);

                foreach (string column in query.Kind == MiiQueryKind.Sql ? SqlColumns.Extract(query.Text) : MdoAttributes(query.Text))
                {
                    contract.Result.Add(column, CsType.String, true);
                }
            }

            if (query.Kind == MiiQueryKind.Xacute)
            {
                contract.XacuteTarget = context.FindTransaction(query.XacuteTransaction);
            }
        }

        private static List<string> MdoAttributes(string text)
        {
            List<string> result = new List<string>();
            int select = text.IndexOf("SELECT ", StringComparison.Ordinal);
            int from = text.IndexOf(" FROM ", StringComparison.Ordinal);

            if (select < 0 || from < select)
            {
                return result;
            }

            foreach (string part in text.Substring(select + 7, from - select - 7).Split(','))
            {
                string name = part.Trim().Trim('[', ']').Trim();

                if (name.Length > 0 && name != "*")
                {
                    result.Add(name);
                }
            }

            return result;
        }

        /// <summary>Query actions keep the result of the developer's last test run (Results); its Columns element is
        /// the exact result contract, with SQL data types.</summary>
        private static void AddCachedQueryColumns(GenerationContext context)
        {
            foreach (MiiTransaction transaction in context.Graph.Transactions)
            {
                foreach (MiiActionDefinition action in transaction.Actions.Values)
                {
                    if (!action.HasProperty("QueryTemplate"))
                    {
                        continue;
                    }

                    QueryContract query = context.FindQuery(action.Static("QueryTemplate"));

                    if (query == null || query.Result == null)
                    {
                        continue;
                    }

                    XmlDocument cached = MiiXml.TryParse(MiiXml.OwnText(action.Property("Results")));
                    ContractFactory.AddColumnsFromRowsets(query.Result, cached);
                }
            }
        }
    }
}

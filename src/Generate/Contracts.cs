using System;
using System.Collections.Generic;
using System.Xml;
using MiiXRay.Model;
using MiiXRay.Resolve;
using MiiXRay.Sources;

namespace MiiXRay.Generate
{
    /// <summary>A property of a generated class (request, response) or a local variable.</summary>
    public sealed class PropertySpec
    {
        public string MiiName;
        public string Name;
        public CsType Type;
        /// <summary>The initial value as C# code.</summary>
        public string Initializer;
        public string Description;
    }

    /// <summary>The generated class of one transaction: names and types of its request, response and locals.</summary>
    public sealed class TransactionContract
    {
        public MiiTransaction Transaction;
        public string ClassName;
        public List<PropertySpec> RequestProperties = new List<PropertySpec>();
        public List<PropertySpec> ResponseProperties = new List<PropertySpec>();
        public List<PropertySpec> Locals = new List<PropertySpec>();
        public List<RowsetContract> NestedContracts = new List<RowsetContract>();
        /// <summary>Names inside the transaction class (nested classes, constants, the Execute method).</summary>
        public UniqueNames NestedNames = new UniqueNames();

        public PropertySpec FindInput(string miiName)
        {
            return Find(RequestProperties, miiName);
        }

        public PropertySpec FindOutput(string miiName)
        {
            return Find(ResponseProperties, miiName);
        }

        public PropertySpec FindLocal(string miiName)
        {
            return Find(Locals, miiName);
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

        /// <summary>A new row/rowset class pair inside this transaction class.</summary>
        public RowsetContract CreateNestedContract(string baseName, string origin)
        {
            string pascal = Naming.Pascal(baseName).TrimStart('@');
            string rowClass = NestedNames.Claim(pascal + "Row");
            string rowsetClass = NestedNames.Claim(pascal + "Rowset");
            RowsetContract contract = new RowsetContract(ClassName, rowClass, rowsetClass, origin);
            NestedContracts.Add(contract);
            return contract;
        }

        /// <summary>Returns an existing nested contract with the same columns (and drops the new one), or the new one.</summary>
        public RowsetContract ShareIdentical(RowsetContract contract)
        {
            if (contract.Columns.Count == 0)
            {
                return contract;
            }
            foreach (RowsetContract existing in NestedContracts)
            {
                if (existing != contract && existing.Signature == contract.Signature)
                {
                    NestedContracts.Remove(contract);
                    return existing;
                }
            }
            return contract;
        }
    }

    public sealed class QueryParameterSpec
    {
        public int Slot;
        public string PropertyName;
        public string ArgumentName;
        public string DefaultValue;
        public string Description;
    }

    /// <summary>The generated class of one query template.</summary>
    public sealed class QueryContract
    {
        public MiiQuery Query;
        public string ClassName;
        public List<QueryParameterSpec> Parameters = new List<QueryParameterSpec>();
        public RowsetContract Result;
        /// <summary>For an Xacute query: the transaction it forwards to (null when not loaded).</summary>
        public TransactionContract XacuteTarget;

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
            "Mii", "RowBase", "RowsetBase", "IQueryService", "IQueryRequest", "IPluginService", "PluginRequest", "PluginResult",
            "MiiException", "TransactionTerminatedException"
        };

        public ObjectGraph Graph;
        public Dictionary<MiiTransaction, TransactionContract> Transactions = new Dictionary<MiiTransaction, TransactionContract>();
        public Dictionary<MiiQuery, QueryContract> Queries = new Dictionary<MiiQuery, QueryContract>();
        public UniqueNames TypeNames = new UniqueNames();
        public List<string> Notes = new List<string>();

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
    }

    /// <summary>Builds the contracts (class names, request/response/local properties, query parameters and result
    /// rowsets) of every object before any code is generated, so that callers can refer to their callees' types.</summary>
    public static class ContractBuilder
    {
        public static void Build(GenerationContext context)
        {
            foreach (MiiTransaction transaction in context.Graph.Transactions)
            {
                TransactionContract contract = new TransactionContract();
                contract.Transaction = transaction;
                contract.ClassName = ClaimTypeName(context, transaction.Path);
                foreach (string reserved in new string[] { contract.ClassName, "Request", "Response", "Execute", "TransactionPath" })
                {
                    contract.NestedNames.Reserve(reserved);
                }
                context.Transactions.Add(transaction, contract);
            }
            foreach (MiiQuery query in context.Graph.Queries)
            {
                QueryContract contract = new QueryContract();
                contract.Query = query;
                contract.ClassName = ClaimTypeName(context, query.Path);
                context.Queries.Add(query, contract);
            }
            foreach (TransactionContract contract in context.Transactions.Values)
            {
                BuildInterface(contract);
            }
            foreach (QueryContract contract in context.Queries.Values)
            {
                BuildQuery(context, contract);
            }
            AddCachedQueryColumns(context);
        }

        private static string ClaimTypeName(GenerationContext context, string path)
        {
            string name = Naming.Pascal(ObjectPath.Leaf(path)).TrimStart('@');
            if (context.TypeNames.IsUsed(name))
            {
                string folder = ObjectPath.Leaf(ObjectPath.Folder(path));
                if (folder.Length > 0)
                {
                    name = Naming.Pascal(folder).TrimStart('@') + name;
                }
            }
            return context.TypeNames.Claim(name);
        }

        private static void BuildInterface(TransactionContract contract)
        {
            MiiTransaction transaction = contract.Transaction;
            UniqueNames requestNames = new UniqueNames();
            requestNames.Reserve("Request");
            UniqueNames responseNames = new UniqueNames();
            responseNames.Reserve("Response");
            foreach (MiiParameter parameter in transaction.Inputs)
            {
                contract.RequestProperties.Add(Property(contract, parameter, requestNames, false));
            }
            foreach (MiiParameter parameter in transaction.Outputs)
            {
                contract.ResponseProperties.Add(Property(contract, parameter, responseNames, false));
            }
            UniqueNames localNames = new UniqueNames();
            foreach (string reserved in new string[] { "request", "response", "queryService", "pluginService" })
            {
                localNames.Reserve(reserved);
            }
            foreach (MiiParameter parameter in transaction.Locals)
            {
                contract.Locals.Add(Property(contract, parameter, localNames, true));
            }
        }

        private static PropertySpec Property(TransactionContract contract, MiiParameter parameter, UniqueNames names, bool local)
        {
            PropertySpec property = new PropertySpec();
            property.MiiName = parameter.Name;
            property.Name = names.Claim(local ? Naming.Camel(parameter.Name) : Naming.Pascal(parameter.Name));
            property.Description = parameter.Description;
            property.Type = TypeOf(contract, parameter);
            property.Initializer = Initializer(property.Type, parameter.DefaultText);
            return property;
        }

        private static CsType TypeOf(TransactionContract contract, MiiParameter parameter)
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
                    return XmlTypeOf(contract, parameter);
                default:
                    return CsType.String;
            }
        }

        /// <summary>An xml property is typed by its reference document when that is an Illuminator rowset.</summary>
        private static CsType XmlTypeOf(TransactionContract contract, MiiParameter parameter)
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
            RowsetContract rowset = contract.CreateNestedContract(parameter.Name, "reference document of " + parameter.Name);
            ContractFactory.AddColumnsFromRowsets(rowset, document);
            return CsType.RowsetOf(contract.ShareIdentical(rowset));
        }

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
            foreach (string reserved in new string[] { contract.ClassName, "Request", "Row", "Result", "Text" })
            {
                names.Reserve(reserved);
            }
            UniqueNames arguments = new UniqueNames();
            foreach (MiiQueryParameter parameter in query.Parameters)
            {
                QueryParameterSpec spec = new QueryParameterSpec();
                spec.Slot = parameter.Slot;
                string baseName = parameter.Description.Length > 0 ? parameter.Description : "Param" + parameter.Slot;
                if (query.Kind == MiiQueryKind.Xacute && query.XacuteMappedTargets.ContainsKey(parameter.Slot))
                {
                    baseName = query.XacuteMappedTargets[parameter.Slot];
                }
                spec.PropertyName = names.Claim(Naming.Pascal(baseName).TrimStart('@'));
                spec.ArgumentName = arguments.Claim(Naming.Camel(baseName));
                spec.DefaultValue = parameter.DefaultValue ?? string.Empty;
                spec.Description = parameter.Description;
                contract.Parameters.Add(spec);
            }
            if (query.Kind == MiiQueryKind.Sql || query.Kind == MiiQueryKind.Mdo)
            {
                contract.Result = new RowsetContract(contract.ClassName, "Row", "Result", "columns of " + query.Path);
                if (query.Kind == MiiQueryKind.Sql)
                {
                    foreach (string column in SqlColumns.Extract(query.Text))
                    {
                        contract.Result.Add(column, CsType.String, true);
                    }
                }
                else
                {
                    foreach (string column in MdoAttributes(query.Text))
                    {
                        contract.Result.Add(column, CsType.String, true);
                    }
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

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using MiiXRay.Model;

namespace MiiXRay.Generate
{
    /// <summary>Actions: logic actions become C# statements, transaction calls static calls, queries IQueryService
    /// calls; every other MII action becomes an IPluginService call with its configuration.</summary>
    public sealed partial class TransactionEmitter
    {
        private static readonly Regex ParamSlot = new Regex(@"^Param\.(\d+)$", RegexOptions.Compiled);
        private static readonly Regex Secret = new Regex("(?i)password|passwort|secret|^pin$", RegexOptions.Compiled);

        /// <summary>Settings of a transaction call that only steer the MII runtime.</summary>
        private static readonly string[] CallSettings =
        {
            "TransactionName", "ResetState", "Persist", "Async", "LogLevel", "LogType", "StoreTransactionOutput", "Expiration", "Inputs", "Outputs"
        };

        /// <summary>Query action settings that only steer the MII runtime.</summary>
        private static readonly string[] QuerySettings =
        {
            "QueryTemplate", "Server", "RowCount", "DateFormat", "NumberFormat", "XmlDateFormat", "XmlNumberFormat", "AutoCommit",
            "Timeout", "Format", "SQLTransaction", "Results", "ResultsAsString", "ResultSet", "TagList", "QueryStartDate", "QueryEndDate",
            "QueryParameters", "Mode", "InlineTransform"
        };

        /// <summary>Properties that hold the last design-time run (caches) or editor state, never configuration.</summary>
        private static readonly string[] NoiseProperties =
        {
            "Results", "ResultsAsString", "ResultSet", "TagList", "QueryStartDate", "QueryEndDate", "StartDate", "EndDate", "Output",
            "Response", "Item", "Expiration", "LastErrorMessage", "ItemCount", "CurrentItem", "Break", "InputCount", "LogicalAnd",
            "XmlContent", "document", "QueryParameters", "SQLTransaction", "Request", "Success", "TextOutput", "Existed", "Valid", "Messages"
        };

        private static readonly string[] TrivialValues = { "", "INHERIT", "false", "0", "-1", "-9223372036854775808", "NEVER", "Never" };

        private List<string> EmitAction(MiiActionUse use)
        {
            _currentAction = use.Name;
            List<string> lines = new List<string>();

            if (use.Definition == null)
            {
                lines.Add("// X-Ray: action " + use.Name + " has no definition in the transaction");
                Note("action definition missing");
                return lines;
            }

            ActionSymbol symbol = _actions[use.Name];
            lines.Add("// " + use.Name);

            switch (use.Definition.ActionType)
            {
                case "Assignment":
                case "CatchAction":
                    break;
                case "Throw":
                    lines.AddRange(EmitThrow(use));
                    return lines;
                case "TerminateTransaction":
                    lines.AddRange(EmitTerminate(use));
                    return lines;
                case "Tracer":
                    lines.Add("plugins.Log(" + LogText(use, "Level", "DEBUG") + ", " + MessageOf(use, "Message") + ");");
                    break;
                case "EventLogger":
                    lines.Add("plugins.Log(" + LogText(use, "EventType", "INFO") + ", " + MessageOf(use, "Message") + ");");
                    break;
                case "Pause":
                    TypedCode delay = InputValue(use, "Delay", CsType.Int) ?? TypedCode.Primary("0", CsType.Int);
                    lines.Add("Thread.Sleep(" + delay.Code + ");");
                    break;
                case "IlluminatorRow":
                    lines.AddRange(EmitAddRow(use));
                    break;
                case "IlluminatorDocument":
                    if (symbol.Variable != null)
                    {
                        lines.Add(symbol.Variable + " = new " + symbol.VariableType.Name + "();");
                    }

                    break;
                case "StringToXmlConverter":
                    lines.Add(Assign(symbol, "Mii.ParseXml(" + ExpressionTranslator.ToStringCode(InputValue(use, "Input", CsType.String) ?? TypedCode.Primary("\"\"", CsType.String)).Code + ")"));
                    break;
                case "XSLTransform":
                    lines.AddRange(EmitXslTransform(use, symbol));
                    break;
                default:
                    lines.AddRange(EmitCall(use, symbol));
                    break;
            }

            lines.AddRange(EmitOutgoing(use));
            return lines;
        }

        /// <summary>"x = value;" when something reads the action's result, else the call as a statement.</summary>
        private static string Assign(ActionSymbol symbol, string call)
        {
            return symbol.Variable != null ? symbol.Variable + " = " + call + ";" : call + ";";
        }

        private string MessageOf(MiiActionUse use, string property)
        {
            TypedCode message = InputValue(use, property, CsType.String) ?? TypedCode.Primary("\"\"", CsType.String);
            return message.Code;
        }

        private string LogText(MiiActionUse use, string property, string fallback)
        {
            TypedCode level = InputValue(use, property, CsType.String);

            if (level == null || (level.IsLiteral && level.LiteralText.Length == 0))
            {
                return CsLiteral.String(fallback);
            }

            return level.Code;
        }

        private List<string> EmitThrow(MiiActionUse use)
        {
            List<string> lines = new List<string>();
            string statement = "throw new MiiException(" + MessageOf(use, "Message") + ", " + CsLiteral.String(use.Name) + ");";
            TypedCode enable = InputValue(use, "Enable", CsType.Bool);

            if (enable == null || enable.Code == "true")
            {
                lines.Add(statement);
            }
            else if (enable.Code == "false")
            {
                lines.Add("// disabled in MII (Enable = false): " + statement);
            }
            else
            {
                lines.Add("if (" + enable.Code + ")");
                lines.Add("{");
                lines.Add("    " + statement);
                lines.Add("}");
            }

            return lines;
        }

        private List<string> EmitTerminate(MiiActionUse use)
        {
            List<string> lines = new List<string>();
            TypedCode withError = InputValue(use, "TerminateWithError", CsType.Bool) ?? TypedCode.Primary("false", CsType.Bool);
            TypedCode message = InputValue(use, "TerminationMessage", CsType.String);

            if (message == null || (message.IsLiteral && message.LiteralText.Length == 0))
            {
                message = TypedCode.Primary(CsLiteral.String("Transaction Execution Terminated Upon Request"), CsType.String);
            }

            string statement = "throw " + TerminationMarker + CsLiteral.String(_transaction.Path) + ", " + message.Code + ");";

            if (withError.Code == "true")
            {
                lines.Add(statement);
                return lines;
            }

            if (withError.Code != "false")
            {
                lines.Add("if (" + withError.Code + ")");
                lines.Add("{");
                lines.Add("    " + statement);
                lines.Add("}");
            }

            lines.AddRange(EmitOutgoing(use));
            lines.Add(_contract.ReturnStatement);
            return lines;
        }

        private List<string> EmitXslTransform(MiiActionUse use, ActionSymbol symbol)
        {
            List<string> lines = new List<string>();
            TypedCode input = InputValue(use, "Input", CsType.Xml) ?? TypedCode.Primary("new XmlDocument()", CsType.Xml);
            TypedCode stylesheet = InputValue(use, "InputXSL", CsType.Xml);
            string stylesheetCode;

            if (stylesheet != null && !(stylesheet.IsLiteral && stylesheet.LiteralText.Trim().Length == 0))
            {
                stylesheetCode = stylesheet.Code;
            }
            else
            {
                TypedCode path = InputValue(use, "Transform", CsType.String) ?? TypedCode.Primary("\"\"", CsType.String);
                stylesheetCode = "plugins.LoadResource(" + path.Code + ")";
            }

            lines.Add(Assign(symbol, "Mii.XslTransform(" + input.Code + ", " + stylesheetCode + ")"));
            return lines;
        }

        /// <summary>IlluminatorRow: a new row of the document created by an IlluminatorDocument action.</summary>
        private List<string> EmitAddRow(MiiActionUse use)
        {
            List<string> lines = new List<string>();
            TypedCode document = TranslateExpression(LinkedOrStatic(use, "IlluminatorDocument"));
            List<KeyValuePair<string, TypedCode>> values = new List<KeyValuePair<string, TypedCode>>();

            foreach (MiiLink link in use.Incoming)
            {
                LinkTarget target = LinkTarget.Parse(link.To);

                if (target.Selector == null && target.Property != "IlluminatorDocument")
                {
                    values.Add(new KeyValuePair<string, TypedCode>(target.Property, TranslateExpression(link.From)));
                }
            }

            if (document.Type.Kind != TypeKind.Rowset)
            {
                Note("the row's document is not a known rowset; the row is added through Mii.AddRow");
                List<string> arguments = new List<string>();

                foreach (KeyValuePair<string, TypedCode> value in values)
                {
                    arguments.Add(CsLiteral.String(value.Key));
                    arguments.Add(value.Value.Code);
                }

                lines.Add("Mii.AddRow(" + document.Code + (arguments.Count > 0 ? ", " + string.Join(", ", arguments.ToArray()) : string.Empty) + ");");
                return lines;
            }

            RowsetContract contract = document.Type.Contract;
            List<string> assignments = new List<string>();

            foreach (KeyValuePair<string, TypedCode> value in values)
            {
                RowsetColumn column = contract.Ensure(value.Key);
                assignments.Add(column.PropertyName + " = " + ExpressionTranslator.ConvertTo(value.Value, column.Type).Code);
            }

            lines.Add(document.At(Precedence.Primary) + ".Add(new " + contract.RowTypeName + Initializer(assignments) + ");");
            return lines;
        }

        /// <summary>" { A = 1, B = 2 }" or a block with one member per line; "()" when empty.</summary>
        private static string Initializer(List<string> members)
        {
            if (members.Count == 0)
            {
                return "()";
            }

            if (members.Count <= 2 && string.Join(", ", members.ToArray()).Length <= 80)
            {
                return " { " + string.Join(", ", members.ToArray()) + " }";
            }

            StringBuilder block = new StringBuilder("\n{");

            foreach (string member in members)
            {
                block.Append("\n    ").Append(member).Append(',');
            }

            return block.Append("\n}").ToString();
        }

        /// <summary>"(a: x, b: y)" or one named argument per line.</summary>
        private static string ArgumentList(List<string> arguments)
        {
            string single = string.Join(", ", arguments.ToArray());

            if (arguments.Count <= 2 && single.Length <= 80)
            {
                return "(" + single + ")";
            }

            StringBuilder list = new StringBuilder("(");

            for (int index = 0; index < arguments.Count; index++)
            {
                list.Append("\n    ").Append(arguments[index]).Append(index < arguments.Count - 1 ? "," : ")");
            }

            return list.ToString();
        }

        // ------------------------------------------------------------------ calls

        private List<string> EmitCall(MiiActionUse use, ActionSymbol symbol)
        {
            Record(use, symbol);

            switch (symbol.Kind)
            {
                case ActionKind.TransactionCall:
                    return EmitTransactionCall(use, symbol);
                case ActionKind.Xacute:
                    return EmitXacuteCall(use, symbol);
                case ActionKind.Query:
                case ActionKind.QueryCommand:
                    return EmitQuery(use, symbol);
                default:
                    return EmitPluginCall(use, symbol);
            }
        }

        /// <summary>Notes the call for the call tree and the query overview of the file header.</summary>
        private void Record(MiiActionUse use, ActionSymbol symbol)
        {
            OutlineEntry entry = new OutlineEntry();
            entry.ActionName = use.Name;
            entry.Flow = string.Join(" > ", _flow.ToArray());
            entry.Callee = symbol.Callee;

            if (symbol.Query != null)
            {
                entry.Kind = symbol.Callee != null ? "call" : "query";
                entry.Target = symbol.Callee != null ? symbol.Callee.MethodName + " via Xacute query " + symbol.Query.Query.ShortName : symbol.Query.Query.ShortName;
                symbol.Query.Callers.Add(_contract.MethodName + "." + use.Name + (entry.Flow.Length > 0 ? " [" + entry.Flow + "]" : string.Empty));
            }
            else if (symbol.Callee != null)
            {
                entry.Kind = "call";
                entry.Target = symbol.Callee.MethodName;
            }
            else
            {
                entry.Kind = "plugin";
                string transaction = use.Definition.Static("TransactionName");
                entry.Target = use.Definition.ActionType + (transaction.Length > 0 ? " " + transaction : string.Empty);
            }

            _contract.Outline.Add(entry);
        }

        private List<string> EmitTransactionCall(MiiActionUse use, ActionSymbol symbol)
        {
            List<string> lines = new List<string>();
            TransactionContract callee = symbol.Callee;

            if (CsLiteral.IsTrue(use.Definition.Static("Async")))
            {
                lines.Add("// MII runs this call asynchronously");
            }

            List<KeyValuePair<PropertySpec, MiiLink>> inputs = new List<KeyValuePair<PropertySpec, MiiLink>>();

            foreach (MiiLink link in use.Incoming)
            {
                LinkTarget target = LinkTarget.Parse(link.To);

                if (Array.IndexOf(CallSettings, target.Property) >= 0)
                {
                    continue;
                }

                PropertySpec input = callee.FindInput(target.Property);

                if (input == null)
                {
                    lines.Add("// X-Ray: " + callee.MethodName + " has no input " + target.Property + " (stale link): " + OneLine(link.From));
                    Note("link to " + link.To + ": the called transaction has no such input");
                    continue;
                }

                inputs.Add(new KeyValuePair<PropertySpec, MiiLink>(input, link));
            }

            lines.AddRange(EmitMethodCall(use, symbol, inputs));
            return lines;
        }

        /// <summary>An Xacute query is an interface to a transaction: Param.N goes to the mapped input, Results is the
        /// selected output.</summary>
        private List<string> EmitXacuteCall(MiiActionUse use, ActionSymbol symbol)
        {
            List<string> lines = new List<string>();
            TransactionContract callee = symbol.Callee;
            MiiQuery query = symbol.Query.Query;
            lines.Add("// Xacute query " + query.Path + " runs " + callee.Transaction.Path);
            List<KeyValuePair<PropertySpec, MiiLink>> inputs = new List<KeyValuePair<PropertySpec, MiiLink>>();

            foreach (MiiLink link in use.Incoming)
            {
                LinkTarget target = LinkTarget.Parse(link.To);
                Match slot = ParamSlot.Match(target.Property);

                if (!slot.Success)
                {
                    continue;
                }

                string mapped;
                PropertySpec input = null;

                if (query.XacuteMappedTargets.TryGetValue(int.Parse(slot.Groups[1].Value, CultureInfo.InvariantCulture), out mapped))
                {
                    input = callee.FindInput(mapped);
                }

                if (input == null)
                {
                    lines.Add("// X-Ray: " + target.Property + " is not mapped to an input of " + callee.MethodName + ": " + OneLine(link.From));
                    continue;
                }

                inputs.Add(new KeyValuePair<PropertySpec, MiiLink>(input, link));
            }

            lines.AddRange(EmitMethodCall(use, symbol, inputs));
            return lines;
        }

        /// <summary>The call of a transaction's method with named arguments; an input filled through XPath links is built
        /// as a document first.</summary>
        private List<string> EmitMethodCall(MiiActionUse use, ActionSymbol symbol, List<KeyValuePair<PropertySpec, MiiLink>> inputs)
        {
            List<string> lines = new List<string>();
            List<string> order = new List<string>();
            Dictionary<string, string> values = new Dictionary<string, string>();
            Dictionary<string, string> documents = new Dictionary<string, string>();

            foreach (KeyValuePair<PropertySpec, MiiLink> pair in inputs)
            {
                PropertySpec input = pair.Key;
                MiiLink link = pair.Value;
                LinkTarget target = LinkTarget.Parse(link.To);

                if (!order.Contains(input.Name))
                {
                    order.Add(input.Name);
                }

                if (target.Selector == null && link.Kind != "RemoveXml")
                {
                    TypedCode value = ExpressionTranslator.ConvertTo(LinkValue(link, input.Type), input.Type);
                    string document;

                    if (documents.TryGetValue(input.Name, out document))
                    {
                        lines.Add(document + " = " + ExpressionTranslator.ConvertTo(value, CsType.Xml).Code + ";");
                    }
                    else
                    {
                        values[input.Name] = value.Code;
                    }

                    continue;
                }

                string name;

                if (!documents.TryGetValue(input.Name, out name))
                {
                    name = _names.Claim(Naming.Camel(use.Name) + Naming.Pascal(input.MiiName).TrimStart('@'));
                    string start;
                    string initial = values.TryGetValue(input.Name, out start) ? "Mii.ToXml(" + start + ")" : "new XmlDocument()";
                    lines.Add("var " + name + " = " + initial + ";");
                    documents[input.Name] = name;
                }

                lines.AddRange(Write(TypedCode.Primary(name, CsType.Xml), target.Selector == null ? "/*" : target.Selector, link));
                values[input.Name] = ExpressionTranslator.ConvertTo(TypedCode.Primary(name, CsType.Xml), input.Type).Code;
            }

            List<string> arguments = new List<string>();

            foreach (string name in order)
            {
                arguments.Add(name + ": " + values[name]);
            }

            lines.Add(Assign(symbol, symbol.Callee.MethodName + ArgumentList(arguments)));
            return lines;
        }

        /// <summary>A query as a local Query variable: the statement, then AddParameter per linked or configured slot.</summary>
        private List<string> EmitQuery(MiiActionUse use, ActionSymbol symbol)
        {
            List<string> lines = new List<string>();
            QueryContract query = symbol.Query;
            Dictionary<int, string> arguments = new Dictionary<int, string>();
            string text = CsLiteral.String(query.Query.Text);

            foreach (MiiLink link in use.Incoming)
            {
                LinkTarget target = LinkTarget.Parse(link.To);
                Match slot = ParamSlot.Match(target.Property);

                if (slot.Success && target.Selector == null)
                {
                    arguments[int.Parse(slot.Groups[1].Value, CultureInfo.InvariantCulture)] = ExpressionTranslator.ToStringCode(TranslateExpression(link.From)).Code;
                }
                else if (target.Property == "Query" && target.Selector == null)
                {
                    text = ExpressionTranslator.ToStringCode(TranslateExpression(link.From)).Code;
                    lines.Add("// the statement is built at runtime instead of the template text");
                }
                else if (Array.IndexOf(QuerySettings, target.Property) < 0)
                {
                    lines.Add("// X-Ray: query setting not translated: " + OneLine(link.To) + " = " + OneLine(link.From));
                }
            }

            foreach (XmlElement property in MiiXml.ChildElements(use.Definition.Value))
            {
                Match slot = ParamSlot.Match(property.LocalName);

                if (!slot.Success)
                {
                    continue;
                }

                int number = int.Parse(slot.Groups[1].Value, CultureInfo.InvariantCulture);
                string configured = MiiXml.OwnText(property);

                if (!arguments.ContainsKey(number) && configured.Trim().Length > 0)
                {
                    arguments[number] = CsLiteral.String(configured);
                }
            }

            if (query.Parameters.Count > 0)
            {
                List<string> slots = new List<string>();

                foreach (QueryParameterSpec parameter in query.Parameters)
                {
                    slots.Add("[Param." + parameter.Slot.ToString(CultureInfo.InvariantCulture) + "] = " + parameter.Name);
                }

                lines.Add("// " + string.Join(", ", slots.ToArray()));
            }

            string variable = _names.Claim(query.VariableName);
            lines.Add("var " + variable + " = new Query(" + text + ");");
            List<int> numbers = new List<int>(arguments.Keys);
            numbers.Sort();

            foreach (int number in numbers)
            {
                QueryParameterSpec parameter = query.FindParameter(number);

                if (parameter == null)
                {
                    lines.Add("// X-Ray: Param." + number + " is not used by the query text: " + OneLine(arguments[number]));
                    continue;
                }

                lines.Add(variable + ".AddParameter(" + CsLiteral.String(parameter.Name) + ", " + arguments[number] + ");");
            }

            if (symbol.Kind == ActionKind.QueryCommand)
            {
                lines.Add("queries.ExecuteCommand(" + variable + ");");
            }
            else
            {
                lines.Add(Assign(symbol, "queries.Execute<" + query.Result.RowTypeName + ">(" + variable + ")"));
            }

            return lines;
        }

        /// <summary>Any other MII action: an IPluginService call with the action's configuration and linked values.</summary>
        private List<string> EmitPluginCall(MiiActionUse use, ActionSymbol symbol)
        {
            List<string> lines = new List<string>();
            MiiActionDefinition definition = use.Definition;
            List<string> settings = new List<string>();
            Dictionary<string, bool> linked = new Dictionary<string, bool>();
            Dictionary<string, List<MiiLink>> selectorLinks = new Dictionary<string, List<MiiLink>>();

            foreach (MiiLink link in use.Incoming)
            {
                LinkTarget target = LinkTarget.Parse(link.To);
                string property = target.Property;
                linked[property] = true;

                if (target.Selector != null)
                {
                    List<MiiLink> list;

                    if (!selectorLinks.TryGetValue(property, out list))
                    {
                        list = new List<MiiLink>();
                        selectorLinks.Add(property, list);
                    }

                    list.Add(link);
                }
            }

            foreach (XmlElement property in MiiXml.ChildElements(definition.Value))
            {
                string name = property.LocalName;

                if (linked.ContainsKey(name) || Array.IndexOf(NoiseProperties, name) >= 0 || property.HasChildNodes && MiiXml.ChildElements(property).Count > 0 && name != "Request")
                {
                    continue;
                }

                string value = MiiXml.OwnText(property).Trim();

                if (Array.IndexOf(TrivialValues, value) >= 0 || value.StartsWith("<", StringComparison.Ordinal))
                {
                    continue;
                }

                if (Secret.IsMatch(name))
                {
                    value = "***";
                }

                settings.Add("[" + CsLiteral.String(name) + "] = " + CsLiteral.String(value));
            }

            foreach (MiiLink link in use.Incoming)
            {
                LinkTarget target = LinkTarget.Parse(link.To);

                if (target.Selector == null && !selectorLinks.ContainsKey(target.Property) && link.Kind != "RemoveXml")
                {
                    settings.Add("[" + CsLiteral.String(target.Property) + "] = " + LinkValue(link, CsType.Object).Code);
                }
            }

            foreach (KeyValuePair<string, List<MiiLink>> pair in selectorLinks)
            {
                // a document filled through XPath links, starting from the configured template
                string document = _names.Claim(Naming.Camel(use.Name) + Naming.Pascal(pair.Key).TrimStart('@'));
                string template = MiiXml.OwnText(definition.Property(pair.Key)).Trim();
                MiiLink whole = PlainIncoming(use, pair.Key);

                if (whole != null)
                {
                    lines.Add("var " + document + " = " + ExpressionTranslator.ConvertTo(LinkValue(whole, CsType.Xml), CsType.Xml).Code + ";");
                }
                else
                {
                    lines.Add("var " + document + " = " + (MiiXml.TryParse(template) != null ? ContractBuilder.Initializer(CsType.Xml, template) : "new XmlDocument()") + ";");
                }

                foreach (MiiLink link in pair.Value)
                {
                    LinkTarget target = LinkTarget.Parse(link.To);

                    if (target.Selector != null)
                    {
                        lines.AddRange(Write(TypedCode.Primary(document, CsType.Xml), target.Selector, link));
                    }
                }

                settings.Add("[" + CsLiteral.String(pair.Key) + "] = " + document);
            }

            string call = "plugins.Invoke(" + CsLiteral.String(definition.ActionType) + ", " + CsLiteral.String(use.Name) + ", new()" + Initializer(settings) + ")";
            lines.Add(Assign(symbol, call.Replace("new()()", "new()")));
            return lines;
        }
    }
}

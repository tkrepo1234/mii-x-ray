using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using MiiXRay.Model;

namespace MiiXRay.Generate
{
    /// <summary>Links: incoming links set an action's properties before it runs, outgoing links write its results
    /// into transaction outputs, locals or other actions afterwards.</summary>
    public sealed partial class TransactionEmitter
    {
        private static readonly Regex SingleRowColumnPath = new Regex(@"^/?Row/([A-Za-z_][A-Za-z0-9_]*)$", RegexOptions.Compiled);
        private static readonly Regex Word = new Regex(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

        /// <summary>A link target split into the property path and the selector: "Transaction.X{/a/b}" -> ("Transaction.X", "/a/b").</summary>
        private sealed class LinkTarget
        {
            public string Path;
            public string Selector;

            public static LinkTarget Parse(string to)
            {
                LinkTarget target = new LinkTarget();
                string text = (to ?? string.Empty).Trim();
                int brace = text.IndexOf('{');

                if (brace >= 0)
                {
                    target.Path = text.Substring(0, brace);
                    string selector = text.Substring(brace + 1);

                    if (selector.EndsWith("}", StringComparison.Ordinal))
                    {
                        selector = selector.Substring(0, selector.Length - 1);
                    }

                    target.Selector = selector.Trim();
                }
                else
                {
                    target.Path = text;
                }

                return target;
            }

            /// <summary>The property below the action: "SelectX.Param.1" -> "Param.1".</summary>
            public string Property
            {
                get
                {
                    int dot = Path.IndexOf('.');
                    return dot >= 0 ? Path.Substring(dot + 1) : Path;
                }
            }
        }

        private TypedCode TranslateExpression(string text)
        {
            return _translator.Translate(text);
        }

        /// <summary>The expression text of the last plain incoming link to Action.Property, or the configured value.</summary>
        private string LinkedOrStatic(MiiActionUse use, string property)
        {
            MiiLink link = PlainIncoming(use, property);
            return link != null ? link.From : use.Definition.Static(property);
        }

        private MiiLink PlainIncoming(MiiActionUse use, string property)
        {
            MiiLink result = null;

            foreach (MiiLink link in use.Incoming)
            {
                LinkTarget target = LinkTarget.Parse(link.To);

                if (target.Selector == null && target.Property == property && link.Kind != "RemoveXml")
                {
                    result = link;
                }
            }

            return result;
        }

        /// <summary>The value of an action property as C#: the linked expression, else the configured value as a literal;
        /// null when neither exists.</summary>
        private TypedCode InputValue(MiiActionUse use, string property, CsType type)
        {
            MiiLink link = PlainIncoming(use, property);

            if (link != null)
            {
                return ExpressionTranslator.ConvertTo(LinkValue(link, type), type);
            }

            if (use.Definition == null || !use.Definition.HasProperty(property))
            {
                return null;
            }

            string configured = use.Definition.Static(property);

            if (configured.Length == 0 && type.Kind != TypeKind.String)
            {
                return null;
            }

            return StaticValue(configured, type);
        }

        private TypedCode LinkValue(MiiLink link, CsType target)
        {
            TypedCode value = TranslateExpression(link.From);

            if (link.Kind == "AssignXml" && value.XmlCode != null && target.Kind != TypeKind.String)
            {
                return TypedCode.Primary(value.XmlCode, CsType.Xml);
            }

            return value;
        }

        /// <summary>A configured (not linked) property value as a C# literal of the given type.</summary>
        private static TypedCode StaticValue(string text, CsType type)
        {
            TypedCode result;

            switch (type.Kind)
            {
                case TypeKind.Bool:
                    result = TypedCode.Primary(CsLiteral.IsTrue(text) ? "true" : "false", CsType.Bool);
                    break;
                case TypeKind.Int:
                case TypeKind.Long:
                case TypeKind.Double:
                case TypeKind.Decimal:
                    result = TypedCode.Primary(CsLiteral.Number(text, type.Kind), type);

                    if (result.Code.StartsWith("-", StringComparison.Ordinal))
                    {
                        result.Precedence = Precedence.Unary;
                    }

                    break;
                case TypeKind.String:
                case TypeKind.Object:
                    result = TypedCode.Primary(CsLiteral.String(text), CsType.String);
                    break;
                default:
                    result = TypedCode.Primary(ContractBuilder.Initializer(type, text), type);
                    break;
            }

            result.IsLiteral = true;
            result.LiteralText = text;
            return result;
        }

        // ------------------------------------------------------------------ outgoing links

        private List<string> EmitOutgoing(MiiActionUse use)
        {
            List<string> lines = new List<string>();

            foreach (MiiLink link in use.Outgoing)
            {
                lines.AddRange(EmitWrite(link));
            }

            return lines;
        }

        /// <summary>One outgoing link: Transaction.X, Local.X, a loop's Break or (rarely) another action's property.</summary>
        private List<string> EmitWrite(MiiLink link)
        {
            LinkTarget target = LinkTarget.Parse(link.To);
            int dot = target.Path.IndexOf('.');
            string scope = dot >= 0 ? target.Path.Substring(0, dot) : target.Path;
            string member = target.Property;

            if (scope == "Transaction")
            {
                PropertySpec property = _contract.FindOutput(member) ?? _contract.FindInput(member);

                if (property != null)
                {
                    return Write(TypedCode.Primary(property.Name, property.Type), target.Selector, link);
                }
            }
            else if (scope == "Local")
            {
                PropertySpec local = _contract.FindLocal(member);

                if (local != null)
                {
                    return Write(TypedCode.Primary(local.Name, local.Type), target.Selector, link);
                }
            }
            else if (Array.IndexOf(SharedScopes, scope) >= 0 && target.Selector == null)
            {
                List<string> shared = new List<string>();
                shared.Add("plugins.SetProperty(" + CsLiteral.String(target.Path) + ", " + LinkValue(link, CsType.Object).Code + ");");
                return shared;
            }
            else if (member == "Break")
            {
                LoopScope loop = FindLoop(scope);

                if (loop != null && loop.BreakVariable != null)
                {
                    return Write(TypedCode.Primary(loop.BreakVariable, CsType.Bool), null, link);
                }
            }

            ActionSymbol action;

            if (_actions.TryGetValue(scope, out action) && action.Variable != null && IsWritableResult(action, member))
            {
                return Write(TypedCode.Primary(action.Variable, action.VariableType), target.Selector, link);
            }

            Note("link to " + link.To + " has no C# target");
            List<string> lines = new List<string>();
            lines.Add("// X-Ray: not translated: " + OneLine(link.To) + " = " + OneLine(link.From));
            return lines;
        }

        /// <summary>Links may change the document an earlier action produced (an IlluminatorDocument's Output, a query's Results).</summary>
        private static bool IsWritableResult(ActionSymbol action, string member)
        {
            return (member == "Output" && (action.Kind == ActionKind.Document || action.Kind == ActionKind.Xml))
                || (member == "Results" && action.Kind == ActionKind.Query);
        }

        /// <summary>Writes a link's value into a target (a variable or property). Assign = value assignment,
        /// AssignXml = replace the document or the selected node, RemoveXml / AppendXml / AppendAfterXml / ReplaceXml =
        /// XML edits at the selected node.</summary>
        private List<string> Write(TypedCode target, string selector, MiiLink link)
        {
            List<string> lines = new List<string>();
            string kind = link.Kind;

            if (kind == "RemoveXml")
            {
                lines.Add(RemoveXml(target, selector));
                return lines;
            }

            TypedCode value = LinkValue(link, target.Type);

            if (selector == null && (kind == "Assign" || kind == "AssignXml"))
            {
                lines.Add(target.Code + " = " + ExpressionTranslator.ConvertTo(value, target.Type).Code + ";");
                return lines;
            }

            string pathCode = selector == null ? "\"/*\"" : SelectorPath(selector);

            if (kind == "Assign" && selector != null)
            {
                string direct = DirectSelectorWrite(target, selector, value);

                if (direct != null)
                {
                    lines.Add(direct);
                    return lines;
                }
            }

            string method;

            switch (kind)
            {
                case "Assign": method = "Mii.SetXPathValue"; break;
                case "AssignXml": method = "Mii.AssignXml"; break;
                case "AppendXml": method = "Mii.AppendXml"; break;
                case "AppendAfterXml": method = "Mii.AppendAfterXml"; break;
                case "ReplaceXml": method = "Mii.ReplaceXml"; break;
                default:
                    Note("unknown link type " + kind);
                    method = "Mii.SetXPathValue";
                    break;
            }

            lines.Add(XmlEdit(target, method, pathCode + ", " + value.Code));
            return lines;
        }

        /// <summary>Map{key} = v, Row{/Row/Column} = v: plain C# assignments.</summary>
        private string DirectSelectorWrite(TypedCode target, string selector, TypedCode value)
        {
            if (target.Type.Kind == TypeKind.Map && Word.IsMatch(selector))
            {
                return target.Code + "[" + CsLiteral.String(selector) + "] = " + ExpressionTranslator.ToStringCode(value).Code + ";";
            }

            Match column = SingleRowColumnPath.Match(selector);

            if (target.Type.Kind == TypeKind.Row && column.Success)
            {
                RowsetColumn rowColumn = target.Type.Contract.Ensure(column.Groups[1].Value);
                return target.Code + "." + rowColumn.PropertyName + " = " + ExpressionTranslator.ConvertTo(value, rowColumn.Type).Code + ";";
            }

            return null;
        }

        private string RemoveXml(TypedCode target, string selector)
        {
            string path = selector ?? "/*";

            if (target.Type.Kind == TypeKind.Rowset && (path == "/*" || path == "/Rowsets/Rowset/Row" || path == "/Rowsets/Rowset/Row/*"))
            {
                return target.Code + ".Clear();";
            }

            return XmlEdit(target, "Mii.RemoveXml", SelectorPath(path));
        }

        /// <summary>An XML edit on a target: in place for an XmlDocument, through a conversion for anything else.</summary>
        private static string XmlEdit(TypedCode target, string method, string arguments)
        {
            if (target.Type.Kind == TypeKind.Xml)
            {
                return method + "(" + target.Code + ", " + arguments + ");";
            }

            TypedCode edited = TypedCode.Primary(method + "(Mii.ToXml(" + target.Code + "), " + arguments + ")", CsType.Xml);
            return target.Code + " = " + ExpressionTranslator.ConvertTo(edited, target.Type).Code + ";";
        }

        /// <summary>The XPath of a selector as C# (a literal, or a concatenation when it contains #expr# parts).</summary>
        private string SelectorPath(string selector)
        {
            return _translator.SelectorPathCode(selector);
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using MiiXRay.Expressions;
using MiiXRay.Model;

namespace MiiXRay.Generate
{
    /// <summary>The step tree as C# control flow.
    /// Execution model (docs/FORMAT.md 2.5): a step runs its action, then its children in order. Conditional: child 0 =
    /// true path, child 1 = false path, further children run afterwards. Switcher: one child per match value, then the
    /// default, further children afterwards. Loops: child 0 is the body, further children run once after the loop.
    /// Catch: handles whatever ran before it in the same parent (and the parent's own action) - a try block around
    /// those statements; the Catch's children are the handler.</summary>
    public sealed partial class TransactionEmitter
    {
        private const string TerminationMarker = "new TransactionTerminatedException(";

        /// <summary>The lines of the Execute method.</summary>
        public List<string> EmitExecuteMethod()
        {
            List<string> flow = EmitSiblings(_transaction.Steps, new List<string>());

            List<string> lines = new List<string>();
            lines.Add("/// <summary>Runs " + Xml(_transaction.Path) + ".</summary>");
            lines.Add("public static Response Execute(Request request, IQueryService queryService, IPluginService pluginService)");
            lines.Add("{");
            List<string> body = new List<string>();
            body.Add("Response response = new Response();");
            if (_contract.Locals.Count > 0)
            {
                body.Add(string.Empty);
                body.Add("// Local variables");
                foreach (PropertySpec local in _contract.Locals)
                {
                    body.Add(local.Type.Name + " " + local.Name + " = " + local.Initializer + ";");
                }
            }
            List<string> results = new List<string>();
            foreach (MiiActionDefinition definition in _transaction.Actions.Values)
            {
                ActionSymbol symbol = _actions[definition.Name];
                if (symbol.Variable != null)
                {
                    results.Add(symbol.VariableType.Name + " " + symbol.Variable + " = " + symbol.Initializer + ";");
                }
            }
            if (results.Count > 0)
            {
                body.Add(string.Empty);
                body.Add("// Action results (MII keeps them for the whole run)");
                body.AddRange(results);
            }
            if (flow.Count > 0)
            {
                body.Add(string.Empty);
                body.AddRange(flow);
            }
            body.Add(string.Empty);
            body.Add("return response;");
            lines.AddRange(Indent(body));
            lines.Add("}");
            return lines;
        }

        /// <summary>Steps in order; a Catch wraps everything before it (including the lines passed in) in a try block.</summary>
        private List<string> EmitSiblings(List<MiiStep> steps, List<string> before)
        {
            List<string> lines = before;
            foreach (MiiStep step in steps)
            {
                if (step.StepType == "Catch")
                {
                    lines = WrapInTry(lines, step);
                }
                else
                {
                    lines.AddRange(EmitStep(step));
                }
            }
            return lines;
        }

        private List<string> EmitStep(MiiStep step)
        {
            switch (step.StepType)
            {
                case "Conditional":
                    return EmitConditional(step);
                case "Switcher":
                    return EmitSwitcher(step);
                case "Iterator":
                case "Repeater":
                case "ForNextRepeater":
                case "WhileRepeater":
                    return EmitLoop(step);
                case "Catch":
                    return WrapInTry(new List<string>(), step);
                default:
                    List<string> lines = new List<string>();
                    if (step.StepType != "ActionSequence")
                    {
                        lines.Add("// X-Ray: unknown step type " + step.StepType + ", run as a sequence");
                    }
                    if (step.Action != null)
                    {
                        lines.AddRange(EmitAction(step.Action));
                    }
                    return EmitSiblings(step.Children, lines);
            }
        }

        // ------------------------------------------------------------------ exception handling

        private List<string> WrapInTry(List<string> guarded, MiiStep catchStep)
        {
            string name = catchStep.Action != null ? catchStep.Action.Name : catchStep.Name;
            _currentAction = name;
            if (!HasCode(guarded))
            {
                guarded.Add("// " + name + ": catches nothing (no action runs before it), its handler never runs");
                return guarded;
            }
            ActionSymbol symbol = null;
            if (catchStep.Action != null)
            {
                _actions.TryGetValue(catchStep.Action.Name, out symbol);
            }
            string error = _names.Claim(Naming.Camel(name) + "Error");
            List<string> handler = new List<string>();
            handler.Add("// " + name);
            if (ContainsTermination(guarded))
            {
                // Terminate Transaction is no exception in MII: a Catch does not stop it
                handler.Add("if (Mii.IsTerminationOf(" + error + ", TransactionPath))");
                handler.Add("{");
                handler.Add("    throw;");
                handler.Add("}");
            }
            if (symbol != null && symbol.Variable != null)
            {
                handler.Add(symbol.Variable + " = " + error + ";");
            }
            if (catchStep.Action != null)
            {
                handler.AddRange(EmitOutgoing(catchStep.Action));
            }
            List<string> children = EmitSiblings(catchStep.Children, new List<string>());
            handler.AddRange(children);
            if (!HasCode(children) && (symbol == null || symbol.Variable == null))
            {
                handler.Add("// the exception is swallowed");
            }

            List<string> lines = new List<string>();
            lines.Add("try");
            lines.Add("{");
            lines.AddRange(Indent(guarded));
            lines.Add("}");
            lines.Add("catch (Exception " + error + ")");
            lines.Add("{");
            lines.AddRange(Indent(handler));
            lines.Add("}");
            return lines;
        }

        private static bool ContainsTermination(List<string> lines)
        {
            foreach (string line in lines)
            {
                if (line.IndexOf(TerminationMarker, StringComparison.Ordinal) >= 0)
                {
                    return true;
                }
            }
            return false;
        }

        private static bool HasCode(List<string> lines)
        {
            foreach (string line in lines)
            {
                string trimmed = line.Trim();
                if (trimmed.Length > 0 && !trimmed.StartsWith("//", StringComparison.Ordinal))
                {
                    return true;
                }
            }
            return false;
        }

        // ------------------------------------------------------------------ branches

        private List<string> EmitConditional(MiiStep step)
        {
            List<string> lines = new List<string>();
            MiiActionUse use = step.Action;
            if (use == null || use.Definition == null)
            {
                lines.Add("// X-Ray: conditional step " + step.Name + " without action; its paths follow as a sequence");
                return EmitSiblings(step.Children, lines);
            }
            _currentAction = use.Name;
            int count = ParseCount(use.Definition.Static("InputCount"), 1);
            bool logicalAnd = use.Definition.Static("LogicalAnd").Length == 0 || CsLiteral.IsTrue(use.Definition.Static("LogicalAnd"));
            List<TypedCode> terms = new List<TypedCode>();
            for (int index = 1; index <= count; index++)
            {
                TypedCode term = InputValue(use, "Input" + index, CsType.Bool);
                terms.Add(term ?? TypedCode.Primary("false", CsType.Bool));
            }
            TypedCode condition = Combine(terms, logicalAnd);
            lines.Add("// " + use.Name);
            lines.AddRange(EmitOutgoing(use));

            List<string> whenTrue = step.Children.Count > 0 ? EmitStep(step.Children[0]) : new List<string>();
            List<string> whenFalse = step.Children.Count > 1 ? EmitStep(step.Children[1]) : new List<string>();
            if (condition.Code == "true" && !HasCode(whenFalse))
            {
                lines[0] = "// " + use.Name + ": always true";
                lines.AddRange(whenTrue);
            }
            else
            {
                lines.Add("if (" + condition.Code + ")");
                lines.Add("{");
                lines.AddRange(Indent(whenTrue));
                lines.Add("}");
                if (HasCode(whenFalse))
                {
                    lines.Add("else");
                    lines.Add("{");
                    lines.AddRange(Indent(whenFalse));
                    lines.Add("}");
                }
            }
            return EmitSiblings(Rest(step.Children, 2), lines);
        }

        private static TypedCode Combine(List<TypedCode> terms, bool logicalAnd)
        {
            if (terms.Count == 1)
            {
                return terms[0];
            }
            int precedence = logicalAnd ? Precedence.LogicalAnd : Precedence.LogicalOr;
            List<string> parts = new List<string>();
            foreach (TypedCode term in terms)
            {
                parts.Add(term.At(precedence + 1));
            }
            return new TypedCode(string.Join(logicalAnd ? " && " : " || ", parts.ToArray()), CsType.Bool, precedence);
        }

        private List<string> EmitSwitcher(MiiStep step)
        {
            List<string> lines = new List<string>();
            MiiActionUse use = step.Action;
            if (use == null || use.Definition == null)
            {
                lines.Add("// X-Ray: switch step " + step.Name + " without action; its paths follow as a sequence");
                return EmitSiblings(step.Children, lines);
            }
            _currentAction = use.Name;
            int matchCount = ParseCount(use.Definition.Static("MatchCount"), 0);
            TypedCode subject = InputValue(use, "InputValue", CsType.String) ?? TypedCode.Primary("\"\"", CsType.String);
            string variable = _names.Claim(Naming.Camel(use.Name) + "Value");
            lines.Add("// " + use.Name);
            lines.Add("string " + variable + " = " + subject.Code + ";");
            lines.AddRange(EmitOutgoing(use));
            for (int index = 0; index <= matchCount && index < step.Children.Count; index++)
            {
                List<string> branch = EmitStep(step.Children[index]);
                if (index < matchCount)
                {
                    TypedCode match = InputValue(use, "MatchValue" + (index + 1).ToString(CultureInfo.InvariantCulture), CsType.String)
                        ?? TypedCode.Primary("\"\"", CsType.String);
                    lines.Add((index == 0 ? "if (" : "else if (") + variable + " == " + match.At(Precedence.Equality + 1) + ")");
                }
                else
                {
                    if (!HasCode(branch))
                    {
                        break;
                    }
                    lines.Add(matchCount == 0 ? "// default path" : "else");
                }
                lines.Add("{");
                lines.AddRange(Indent(branch));
                lines.Add("}");
            }
            return EmitSiblings(Rest(step.Children, matchCount + 1), lines);
        }

        // ------------------------------------------------------------------ loops

        private List<string> EmitLoop(MiiStep step)
        {
            List<string> lines = new List<string>();
            MiiActionUse use = step.Action;
            if (use == null || use.Definition == null)
            {
                lines.Add("// X-Ray: loop step " + step.Name + " without action; its body follows as a sequence");
                return EmitSiblings(step.Children, lines);
            }
            _currentAction = use.Name;
            string type = use.Definition.ActionType;
            LoopScope loop = new LoopScope();
            loop.ActionName = use.Name;
            loop.ActionType = type;
            string camel = Naming.Camel(use.Name);
            lines.Add("// " + use.Name);
            if (IsLinkTarget(use.Name, "Break"))
            {
                loop.BreakVariable = _names.Claim(camel + "Break");
                lines.Add("bool " + loop.BreakVariable + " = false;");
            }

            string header;
            bool countsItems = false;
            if (type == "ForNextRepeaterAction")
            {
                header = ForHeader(use, loop, camel);
            }
            else if (type == "WhileRepeaterAction")
            {
                string counter = _names.Claim(camel + "Iteration");
                TypedCode maximum = InputValue(use, "MaxIterations", CsType.Int) ?? TypedCode.Primary("int.MaxValue", CsType.Int);
                loop.Index = TypedCode.Primary(counter, CsType.Int);
                header = "for (int " + counter + " = 1; " + counter + " <= " + maximum.At(Precedence.Relational + 1) + "; " + counter + "++)";
                if (loop.BreakVariable == null)
                {
                    Note("a while loop without a Break link never ends before MaxIterations");
                }
            }
            else
            {
                header = ForEachHeader(use, loop, camel, lines);
                countsItems = type == "RepeaterAction" && IsReferenced(use.Name, "CurrentItem");
                if (countsItems)
                {
                    string index = _names.Claim(camel + "Index");
                    loop.Index = TypedCode.Primary(index, CsType.Int);
                    lines.Add("int " + index + " = 0;");
                }
            }

            _loops.Add(loop);
            List<string> body = new List<string>();
            if (loop.BreakVariable != null)
            {
                body.Add("if (" + loop.BreakVariable + ")");
                body.Add("{");
                body.Add("    break;");
                body.Add("}");
            }
            if (countsItems)
            {
                body.Add(loop.Index.Code + "++;");
            }
            body.AddRange(EmitOutgoing(use));
            if (step.Children.Count > 0)
            {
                body.AddRange(EmitStep(step.Children[0]));
            }
            _loops.RemoveAt(_loops.Count - 1);

            lines.Add(header);
            lines.Add("{");
            lines.AddRange(Indent(body));
            lines.Add("}");
            return EmitSiblings(Rest(step.Children, 1), lines);
        }

        private string ForHeader(MiiActionUse use, LoopScope loop, string camel)
        {
            string counter = _names.Claim(camel + "Counter");
            TypedCode from = InputValue(use, "From", CsType.Int) ?? TypedCode.Primary("0", CsType.Int);
            TypedCode to = InputValue(use, "To", CsType.Int) ?? TypedCode.Primary("0", CsType.Int);
            TypedCode increment = InputValue(use, "Step", CsType.Int) ?? TypedCode.Primary("1", CsType.Int);
            loop.Index = TypedCode.Primary(counter, CsType.Int);
            bool down = increment.IsLiteral && increment.Code.StartsWith("-", StringComparison.Ordinal);
            string step = increment.Code == "1" ? counter + "++" : counter + " += " + increment.Code;
            return "for (int " + counter + " = " + from.Code + "; " + counter + (down ? " >= " : " <= ") + to.At(Precedence.Relational + 1) + "; " + step + ")";
        }

        /// <summary>Repeater over Doc{xpath} (typed rows when Doc is a known rowset and the XPath selects its rows) or
        /// Iterator over a list.</summary>
        private string ForEachHeader(MiiActionUse use, LoopScope loop, string camel, List<string> lines)
        {
            string itemName = _names.Claim(camel + "Item");
            string sourceText = LinkedOrStatic(use, "Source");
            if (use.Definition.ActionType == "IteratorAction")
            {
                TypedCode list = ExpressionTranslator.ConvertTo(TranslateExpression(sourceText), CsType.List);
                if (IsReferenced(use.Name, "ItemCount"))
                {
                    string items = _names.Claim(camel + "Items");
                    lines.Add("List<string> " + items + " = " + list.Code + ";");
                    list = TypedCode.Primary(items, CsType.List);
                    loop.Count = TypedCode.Primary(items + ".Count", CsType.Int);
                }
                loop.Item = TypedCode.Primary(itemName, CsType.String);
                return "foreach (string " + itemName + " in " + list.Code + ")";
            }

            ReferenceNode reference = ParseQuietly(sourceText) as ReferenceNode;
            if (reference != null && reference.Selector != null)
            {
                ReferenceNode baseReference = new ReferenceNode();
                baseReference.Path = reference.Path;
                TypedCode baseCode = Resolve(baseReference);
                if (baseCode == null)
                {
                    Note("unknown reference " + reference.Path);
                    baseCode = _translator.Unresolved(reference.Path);
                }
                string path = reference.Selector.Trim();
                if (baseCode.Type.Kind == TypeKind.Rowset && (path == "/Rowsets/Rowset/Row" || path == "Rowsets/Rowset/Row"))
                {
                    string rows = baseCode.At(Precedence.Primary) + ".Rows";
                    loop.Item = TypedCode.Primary(itemName, CsType.RowOf(baseCode.Type.Contract));
                    loop.Count = TypedCode.Primary(rows + ".Count", CsType.Int);
                    return "foreach (" + loop.Item.Type.Name + " " + itemName + " in " + rows + ")";
                }
                string nodes = _names.Claim(camel + "Nodes");
                lines.Add("List<XmlDocument> " + nodes + " = Mii.SelectNodes(" + baseCode.Code + ", " + CsLiteral.String(path) + ");");
                loop.Item = TypedCode.Primary(itemName, CsType.Xml);
                loop.Count = TypedCode.Primary(nodes + ".Count", CsType.Int);
                return "foreach (XmlDocument " + itemName + " in " + nodes + ")";
            }

            TypedCode source = TranslateExpression(sourceText);
            string fallback = _names.Claim(camel + "Nodes");
            Note(sourceText.Trim().Length == 0 ? "repeater without source, it runs over nothing"
                : "repeater source without XPath, iterating the children of the root element: " + OneLine(sourceText));
            lines.Add("List<XmlDocument> " + fallback + " = Mii.SelectNodes(" + source.Code + ", \"/*/*\");");
            loop.Item = TypedCode.Primary(itemName, CsType.Xml);
            loop.Count = TypedCode.Primary(fallback + ".Count", CsType.Int);
            return "foreach (XmlDocument " + itemName + " in " + fallback + ")";
        }

        private static Node ParseQuietly(string text)
        {
            try
            {
                return Parser.Parse(text);
            }
            catch (ExpressionException)
            {
                return null;
            }
        }

        // ------------------------------------------------------------------ helpers

        private static List<MiiStep> Rest(List<MiiStep> steps, int skip)
        {
            List<MiiStep> rest = new List<MiiStep>();
            for (int index = skip; index < steps.Count; index++)
            {
                rest.Add(steps[index]);
            }
            return rest;
        }

        private static int ParseCount(string text, int fallback)
        {
            int value;
            return int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ? value : fallback;
        }

        public static List<string> Indent(List<string> lines)
        {
            List<string> result = new List<string>(lines.Count);
            foreach (string line in lines)
            {
                result.Add(line.Length == 0 ? line : "    " + line);
            }
            return result;
        }

        private static string Xml(string text)
        {
            return (text ?? string.Empty).Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
        }

        private static readonly Regex Whitespace = new Regex(@"\s+", RegexOptions.Compiled);

        private static string OneLine(string text)
        {
            string value = Whitespace.Replace(text ?? string.Empty, " ").Trim();
            return value.Length > 100 ? value.Substring(0, 100) + "..." : value;
        }
    }
}

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

        /// <summary>The lines of the transaction's method: inputs are parameters, outputs the return value.</summary>
        public List<string> EmitMethod(bool isPublic)
        {
            List<string> flow = EmitSiblings(_transaction.Steps, new List<string>());

            List<string> lines = new List<string>();
            lines.Add("/// <summary>");
            lines.Add("/// " + Xml(_transaction.Path));

            foreach (string line in _transaction.Description.Replace("\r\n", "\n").Split('\n'))
            {
                if (line.Trim().Length > 0)
                {
                    lines.Add("/// " + Xml(line.Trim()));
                }
            }

            lines.Add("/// </summary>");
            lines.AddRange(Signature(isPublic));
            lines.Add("{");

            // outputs live for the whole method (they are returned); locals and action results move to where they are set when they can
            List<string> body = new List<string>();

            foreach (PropertySpec output in _contract.Outputs)
            {
                body.Add(output.Type.Name + " " + output.Name + " = " + output.Initializer + ";");
            }

            List<HoistedVariable> candidates = new List<HoistedVariable>();
            List<string> configuration = new List<string>();

            foreach (PropertySpec local in _contract.Locals)
            {
                if (local.Initializer == ContractBuilder.EmptyValue(local.Type))
                {
                    candidates.Add(Hoisted(local.Type.Name, local.Name, local.Initializer, false));
                }
                else
                {
                    configuration.Add(local.Type.Name + " " + local.Name + " = " + local.Initializer + ";");
                }
            }

            foreach (MiiActionDefinition definition in _transaction.Actions.Values)
            {
                ActionSymbol symbol = _actions[definition.Name];

                if (symbol.Variable != null)
                {
                    candidates.Add(Hoisted(symbol.VariableType.Name, symbol.Variable, symbol.Initializer, symbol.Kind == ActionKind.Catch));
                }
            }

            foreach (HoistedVariable variable in DeclarationPlacer.Place(flow, candidates))
            {
                body.Add(variable.Type + " " + variable.Name + " = " + variable.Initializer + ";");
            }

            body.AddRange(configuration);

            if (flow.Count > 0)
            {
                if (body.Count > 0)
                {
                    body.Add(string.Empty);
                }

                body.AddRange(flow);
            }

            if (_contract.Outputs.Count > 0)
            {
                body.Add(string.Empty);
                body.Add(_contract.ReturnStatement);
            }

            lines.AddRange(Indent(body));
            lines.Add("}");
            return lines;
        }

        private static HoistedVariable Hoisted(string type, string name, string initializer, bool isCatch)
        {
            HoistedVariable variable = new HoistedVariable();
            variable.Type = type;
            variable.Name = name;
            variable.Initializer = initializer;
            variable.IsCatch = isCatch;
            return variable;
        }

        /// <summary>"public BomGetDetailsResult TrxBomGetDetails(string site = default, ...)"; long lists one per line.
        /// Every parameter is optional: a caller passes the inputs MII links, the others stay empty.</summary>
        private List<string> Signature(bool isPublic)
        {
            List<string> parameters = new List<string>();

            foreach (PropertySpec input in _contract.Inputs)
            {
                parameters.Add(input.Type.Name + " " + input.Name + " = default");
            }

            string head = (isPublic ? "public " : "private ") + _contract.ReturnTypeName + " " + _contract.MethodName + "(";
            List<string> lines = new List<string>();

            if (parameters.Count <= 3)
            {
                lines.Add(head + string.Join(", ", parameters.ToArray()) + ")");
                return lines;
            }

            lines.Add(head);

            for (int index = 0; index < parameters.Count; index++)
            {
                lines.Add("    " + parameters[index] + (index < parameters.Count - 1 ? "," : ")"));
            }

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
                handler.Add("if (Mii.IsTerminationOf(" + error + ", " + CsLiteral.String(_transaction.Path) + "))");
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

            _flow.Add("on error " + name);
            List<string> children = EmitSiblings(catchStep.Children, new List<string>());
            _flow.RemoveAt(_flow.Count - 1);
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

            bool alwaysTrue = condition.Code == "true";
            List<string> whenTrue = EmitBranch(step.Children, 0, alwaysTrue ? null : "if " + use.Name);
            List<string> whenFalse = EmitBranch(step.Children, 1, "else " + use.Name);

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
            lines.Add("var " + variable + " = " + subject.Code + ";");
            lines.AddRange(EmitOutgoing(use));

            for (int index = 0; index <= matchCount && index < step.Children.Count; index++)
            {
                List<string> branch = EmitBranch(step.Children, index, index < matchCount ? "case " + (index + 1) + " of " + use.Name : "default of " + use.Name);

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
                lines.Add("var " + loop.BreakVariable + " = false;");
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
                    lines.Add("var " + index + " = 0;");
                }
            }

            _loops.Add(loop);
            _flow.Add("loop " + use.Name);
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
            _flow.RemoveAt(_flow.Count - 1);

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
                    lines.Add("var " + items + " = " + list.Code + ";");
                    list = TypedCode.Primary(items, CsType.List);
                    loop.Count = TypedCode.Primary(items + ".Count", CsType.Int);
                }

                loop.Item = TypedCode.Primary(itemName, CsType.String);
                return "foreach (var " + itemName + " in " + list.Code + ")";
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
                    loop.Item = TypedCode.Primary(itemName, CsType.RowOf(baseCode.Type.Contract));
                    loop.Count = TypedCode.Primary(baseCode.At(Precedence.Primary) + ".Count", CsType.Int);
                    return "foreach (var " + itemName + " in " + baseCode.Code + ")";
                }

                string nodes = _names.Claim(camel + "Nodes");
                lines.Add("var " + nodes + " = Mii.SelectNodes(" + baseCode.Code + ", " + CsLiteral.String(path) + ");");
                loop.Item = TypedCode.Primary(itemName, CsType.Xml);
                loop.Count = TypedCode.Primary(nodes + ".Count", CsType.Int);
                return "foreach (var " + itemName + " in " + nodes + ")";
            }

            TypedCode source = TranslateExpression(sourceText);
            string fallback = _names.Claim(camel + "Nodes");
            Note(sourceText.Trim().Length == 0 ? "repeater without source, it runs over nothing"
                : "repeater source without XPath, iterating the children of the root element: " + OneLine(sourceText));
            lines.Add("var " + fallback + " = Mii.SelectNodes(" + source.Code + ", \"/*/*\");");
            loop.Item = TypedCode.Primary(itemName, CsType.Xml);
            loop.Count = TypedCode.Primary(fallback + ".Count", CsType.Int);
            return "foreach (var " + itemName + " in " + fallback + ")";
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

        /// <summary>A branch step with its flow context for the call tree (null = no context, e.g. an always-true condition).</summary>
        private List<string> EmitBranch(List<MiiStep> children, int index, string context)
        {
            if (index >= children.Count)
            {
                return new List<string>();
            }

            if (context != null)
            {
                _flow.Add(context);
            }

            List<string> lines = EmitStep(children[index]);

            if (context != null)
            {
                _flow.RemoveAt(_flow.Count - 1);
            }

            return lines;
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

            // every physical line, so that raw string literals (closing quotes at the start of a line) keep their value
            foreach (string line in lines)
            {
                result.Add(line.Length == 0 ? line : "    " + line.Replace("\r\n", "\n").Replace("\n", "\n    "));
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

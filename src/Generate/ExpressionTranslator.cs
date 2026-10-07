using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using MiiXRay.Expressions;

namespace MiiXRay.Generate
{
    /// <summary>What the translator needs from the transaction being generated.</summary>
    public interface ISymbolResolver
    {
        /// <summary>The C# form of a reference without its selector, or null when the name is unknown.</summary>
        TypedCode Resolve(ReferenceNode reference);

        /// <summary>Records a note for the file header.</summary>
        void Note(string message);
    }

    /// <summary>Translates MII expressions into C#. Known types use native operators; anything else goes through the
    /// Mii.* helpers, which take object, so the result always compiles.</summary>
    public sealed class ExpressionTranslator
    {
        private static readonly Regex RowColumn = new Regex(@"^/Rowsets/Rowset/Row/([A-Za-z_][A-Za-z0-9_]*)$", RegexOptions.Compiled);
        private static readonly Regex IndexedRowColumn = new Regex(@"^/Rowsets/Rowset/Row\[(\d+)\]/([A-Za-z_][A-Za-z0-9_]*)$", RegexOptions.Compiled);
        private static readonly Regex FilteredRowColumn = new Regex(@"^/Rowsets/Rowset/Row\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([^']*)'\s*\]/([A-Za-z_][A-Za-z0-9_]*)$", RegexOptions.Compiled);
        private static readonly Regex RowCount = new Regex(@"^count\(\s*/Rowsets/Rowset/Row\s*\)$", RegexOptions.Compiled);
        private static readonly Regex SingleRowColumn = new Regex(@"^/?Row/([A-Za-z_][A-Za-z0-9_]*)$", RegexOptions.Compiled);
        private static readonly Regex Word = new Regex(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);
        private static readonly Regex Index = new Regex(@"^\d+$", RegexOptions.Compiled);

        private static readonly Dictionary<string, HelperFunction> Helpers = CreateHelpers();

        private readonly ISymbolResolver _symbols;

        public ExpressionTranslator(ISymbolResolver symbols)
        {
            _symbols = symbols;
        }

        /// <summary>Translates an expression text; an expression that cannot be parsed becomes Mii.Unparsed(...) and a note.</summary>
        public TypedCode Translate(string expression)
        {
            if (expression != null && expression.Trim() == "<<REMOVE>>")
            {
                // the marker of a Remove XML link, no value
                return TypedCode.Primary("null", CsType.Object);
            }
            Node node;
            try
            {
                node = Parser.Parse(expression);
            }
            catch (ExpressionException exception)
            {
                _symbols.Note("expression not understood (" + exception.Message + "): " + OneLine(expression));
                return TypedCode.Primary("Mii.Unparsed(" + CsLiteral.String(expression) + ")", CsType.Object);
            }
            return Translate(node);
        }

        public TypedCode Translate(Node node)
        {
            if (node is EmptyNode)
            {
                return Literal("\"\"", CsType.String, string.Empty);
            }
            StringNode text = node as StringNode;
            if (text != null)
            {
                return Literal(CsLiteral.String(text.Value), CsType.String, text.Value);
            }
            NumberNode number = node as NumberNode;
            if (number != null)
            {
                return NumberLiteral(number.Text);
            }
            BooleanNode boolean = node as BooleanNode;
            if (boolean != null)
            {
                return Literal(boolean.Value ? "true" : "false", CsType.Bool, boolean.Value ? "true" : "false");
            }
            KeywordNode keyword = node as KeywordNode;
            if (keyword != null)
            {
                return TranslateKeyword(keyword.Name);
            }
            ReferenceNode reference = node as ReferenceNode;
            if (reference != null)
            {
                return TranslateReference(reference);
            }
            FunctionNode function = node as FunctionNode;
            if (function != null)
            {
                return TranslateFunction(function);
            }
            UnaryNode unary = node as UnaryNode;
            if (unary != null)
            {
                return TranslateUnary(unary);
            }
            BinaryNode binary = node as BinaryNode;
            if (binary != null)
            {
                return TranslateBinary(binary);
            }
            DynamicNode dynamic = node as DynamicNode;
            if (dynamic != null)
            {
                TypedCode inner = Translate(dynamic.Text);
                _symbols.Note("#...# evaluates text as an expression at runtime (not translatable): #" + dynamic.Text + "#");
                return TypedCode.Primary("Mii.Evaluate(" + ToStringCode(inner).Code + ")", CsType.Object);
            }
            ListLiteralNode list = node as ListLiteralNode;
            if (list != null)
            {
                return TypedCode.Primary(ValueLiteral.ListCode(list.Text), CsType.List);
            }
            throw new InvalidOperationException("unknown node " + node.GetType().Name);
        }

        // ------------------------------------------------------------------ literals and keywords

        private static TypedCode Literal(string code, CsType type, string text)
        {
            TypedCode result = TypedCode.Primary(code, type);
            result.IsLiteral = true;
            result.LiteralText = text;
            return result;
        }

        private static TypedCode NumberLiteral(string text)
        {
            int integer;
            if (int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out integer))
            {
                return Literal(integer.ToString(CultureInfo.InvariantCulture), CsType.Int, text);
            }
            long longValue;
            if (long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out longValue))
            {
                return Literal(longValue.ToString(CultureInfo.InvariantCulture) + "L", CsType.Long, text);
            }
            return Literal(CsLiteral.Number(text, TypeKind.Double), CsType.Double, text);
        }

        private TypedCode TranslateKeyword(string name)
        {
            switch (name)
            {
                case "cr": return Literal("\"\\r\"", CsType.String, "\r");
                case "lf": return Literal("\"\\n\"", CsType.String, "\n");
                case "crlf": return Literal("\"\\r\\n\"", CsType.String, "\r\n");
                case "tab": return Literal("\"\\t\"", CsType.String, "\t");
                case "doublequote": return Literal("\"\\\"\"", CsType.String, "\"");
                case "singlequote": return Literal("\"'\"", CsType.String, "'");
                case "datenow": return TypedCode.Primary("DateTime.Now", CsType.DateTime);
                case "today": return TypedCode.Primary("DateTime.Today", CsType.DateTime);
                case "dateformat": return Literal("\"yyyy-MM-dd'T'HH:mm:ss\"", CsType.String, "yyyy-MM-dd'T'HH:mm:ss");
                case "dateoffsetformat": return Literal("\"yyyy-MM-dd'T'HH:mm:ssZ\"", CsType.String, "yyyy-MM-dd'T'HH:mm:ssZ");
                case "datetimezoneformat": return Literal("\"yyyy-MM-dd'T'HH:mm:ssz\"", CsType.String, "yyyy-MM-dd'T'HH:mm:ssz");
                case "currenttimezone": return TypedCode.Primary("TimeZoneInfo.Local.Id", CsType.String);
                case "currenttimeoffset": return TypedCode.Primary("Mii.CurrentTimeOffset()", CsType.String);
                case "timezoneids": return TypedCode.Primary("Mii.TimeZoneIds()", CsType.List);
                case "emptylist": return TypedCode.Primary("new List<string>()", CsType.List);
                case "emptymap": return TypedCode.Primary("new Dictionary<string, string>()", CsType.Map);
                case "nullstring": return Literal("\"\"", CsType.String, string.Empty);
                case "nulldate": return TypedCode.Primary("DateTime.MinValue", CsType.DateTime);
                case "nullnumber": return TypedCode.Primary("double.NaN", CsType.Double);
                case "guid": return TypedCode.Primary("Guid.NewGuid().ToString()", CsType.String);
                case "transactionid": return TypedCode.Primary("Mii.TransactionId", CsType.String);
                case "e": return TypedCode.Primary("Math.E", CsType.Double);
                case "pi": return TypedCode.Primary("Math.PI", CsType.Double);
                case "username": return TypedCode.Primary("Mii.UserName", CsType.String);
                case "transactionpath": return TypedCode.Primary("TransactionPath", CsType.String);
                case "currenttimemillis": return TypedCode.Primary("Mii.CurrentTimeMillis()", CsType.Long);
                case "userlocale": return TypedCode.Primary("Mii.UserLocale", CsType.String);
                case "currenttimezoneoffset": return TypedCode.Primary("Mii.CurrentTimeOffset()", CsType.String);
                default: return Unresolved(name);
            }
        }

        // ------------------------------------------------------------------ references and selectors

        private TypedCode TranslateReference(ReferenceNode reference)
        {
            TypedCode baseCode = _symbols.Resolve(reference);
            if (baseCode == null)
            {
                _symbols.Note("unknown reference " + reference.Path);
                baseCode = Unresolved(reference.Path);
            }
            if (reference.Selector == null)
            {
                return baseCode;
            }
            return ApplySelector(baseCode, reference.Selector);
        }

        public TypedCode Unresolved(string what)
        {
            return TypedCode.Primary("Mii.Unresolved(" + CsLiteral.String(what) + ")", CsType.Object);
        }

        /// <summary>{xpath} on XML, {key} on a map, {index} on a list. Rowset XPaths of the usual forms become typed
        /// property access and register the column in the contract.</summary>
        public TypedCode ApplySelector(TypedCode baseCode, string selector)
        {
            string trimmed = selector.Trim();
            if (trimmed.IndexOf('#') >= 0)
            {
                TypedCode dynamicPath = InterpolatedText(trimmed);
                return XPathCall(baseCode, dynamicPath.Code);
            }
            string pathLiteral = CsLiteral.String(trimmed);
            switch (baseCode.Type.Kind)
            {
                case TypeKind.Map:
                    return TypedCode.Primary("Mii.MapGet(" + baseCode.Code + ", " + pathLiteral + ")", CsType.String);
                case TypeKind.List:
                    if (Index.IsMatch(trimmed))
                    {
                        return TypedCode.Primary("Mii.ListGet(" + baseCode.Code + ", " + trimmed + ")", CsType.String);
                    }
                    break;
                case TypeKind.Rowset:
                    TypedCode typed = RowsetSelector(baseCode, trimmed);
                    if (typed != null)
                    {
                        return typed;
                    }
                    break;
                case TypeKind.Row:
                    Match single = SingleRowColumn.Match(trimmed);
                    if (single.Success)
                    {
                        return ColumnAccess(baseCode.At(Precedence.Primary), baseCode.Type.Contract, single.Groups[1].Value, baseCode, pathLiteral);
                    }
                    if (trimmed == "/Row" || trimmed == "Row")
                    {
                        return baseCode;
                    }
                    break;
                case TypeKind.Xml:
                    return XPathCall(baseCode, pathLiteral);
            }
            if (Word.IsMatch(trimmed) && baseCode.Type.Kind != TypeKind.Rowset && baseCode.Type.Kind != TypeKind.Row)
            {
                // a key on something of unknown type: map lookup or XPath, decided at runtime
                TypedCode result = TypedCode.Primary("Mii.Select(" + baseCode.Code + ", " + pathLiteral + ")", CsType.String);
                result.XmlCode = "Mii.SelectXml(" + baseCode.Code + ", " + pathLiteral + ")";
                return result;
            }
            return XPathCall(baseCode, pathLiteral);
        }

        private static TypedCode XPathCall(TypedCode baseCode, string pathCode)
        {
            TypedCode result = TypedCode.Primary("Mii.XPath(" + baseCode.Code + ", " + pathCode + ")", CsType.String);
            result.XmlCode = "Mii.SelectXml(" + baseCode.Code + ", " + pathCode + ")";
            return result;
        }

        private TypedCode RowsetSelector(TypedCode baseCode, string path)
        {
            string target = baseCode.At(Precedence.Primary);
            string pathLiteral = CsLiteral.String(path);
            RowsetContract contract = baseCode.Type.Contract;
            Match match = RowColumn.Match(path);
            if (match.Success)
            {
                return ColumnAccess(target + ".FirstRow", contract, match.Groups[1].Value, baseCode, pathLiteral);
            }
            match = IndexedRowColumn.Match(path);
            if (match.Success)
            {
                return ColumnAccess(target + ".RowAt(" + match.Groups[1].Value + ")", contract, match.Groups[2].Value, baseCode, pathLiteral);
            }
            match = FilteredRowColumn.Match(path);
            if (match.Success)
            {
                RowsetColumn filter = contract.Ensure(match.Groups[1].Value);
                string row = target + ".FirstRowWhere(" + CsLiteral.String(filter.Name) + ", " + CsLiteral.String(match.Groups[2].Value) + ")";
                return ColumnAccess(row, contract, match.Groups[3].Value, baseCode, pathLiteral);
            }
            if (RowCount.IsMatch(path))
            {
                return TypedCode.Primary(target + ".Rows.Count", CsType.Int);
            }
            return null;
        }

        private static TypedCode ColumnAccess(string row, RowsetContract contract, string columnName, TypedCode baseCode, string pathLiteral)
        {
            RowsetColumn column = contract.Ensure(columnName);
            TypedCode result = TypedCode.Primary(row + "." + column.PropertyName, column.Type);
            result.XmlCode = "Mii.SelectXml(" + baseCode.Code + ", " + pathLiteral + ")";
            return result;
        }

        /// <summary>The XPath of a selector as C#: a literal, or a concatenation when it contains #expr# parts.</summary>
        public string SelectorPathCode(string selector)
        {
            string trimmed = selector.Trim();
            return trimmed.IndexOf('#') >= 0 ? InterpolatedText(trimmed).Code : CsLiteral.String(trimmed);
        }

        /// <summary>Text with #expr# parts (inside a selector) as a string concatenation.</summary>
        private TypedCode InterpolatedText(string text)
        {
            List<string> parts = new List<string>();
            int position = 0;
            while (position < text.Length)
            {
                int open = text.IndexOf('#', position);
                int close = open < 0 ? -1 : text.IndexOf('#', open + 1);
                if (open < 0 || close < 0)
                {
                    parts.Add(CsLiteral.String(text.Substring(position)));
                    break;
                }
                if (open > position)
                {
                    parts.Add(CsLiteral.String(text.Substring(position, open - position)));
                }
                parts.Add(ToStringCode(Translate(text.Substring(open + 1, close - open - 1))).At(Precedence.Additive + 1));
                position = close + 1;
            }
            if (parts.Count == 0)
            {
                return Literal("\"\"", CsType.String, string.Empty);
            }
            return new TypedCode(string.Join(" + ", parts.ToArray()), CsType.String, parts.Count == 1 ? Precedence.Primary : Precedence.Additive);
        }

        // ------------------------------------------------------------------ operators

        private TypedCode TranslateUnary(UnaryNode unary)
        {
            TypedCode operand = Translate(unary.Operand);
            if (unary.Operator == "!")
            {
                return new TypedCode("!" + ToBoolCode(operand).At(Precedence.Unary), CsType.Bool, Precedence.Unary);
            }
            TypedCode numeric = ToNumericCode(operand);
            return new TypedCode("-" + numeric.At(Precedence.Unary), numeric.Type, Precedence.Unary);
        }

        private TypedCode TranslateBinary(BinaryNode binary)
        {
            if (binary.Operator == "&")
            {
                return Concatenation(binary);
            }
            TypedCode left = Translate(binary.Left);
            TypedCode right = Translate(binary.Right);
            switch (binary.Operator)
            {
                case "+":
                case "-":
                case "*":
                case "/":
                case "%":
                    return Arithmetic(binary.Operator, left, right);
                case "^":
                    return TypedCode.Primary("Math.Pow(" + ToDoubleCode(left).Code + ", " + ToDoubleCode(right).Code + ")", CsType.Double);
                case "<":
                case ">":
                case "<=":
                case ">=":
                    return Relational(binary.Operator, left, right);
                case "==":
                case "!=":
                    return Equality(binary.Operator, left, right);
                case "&&":
                    return new TypedCode(ToBoolCode(left).At(Precedence.LogicalAnd) + " && " + ToBoolCode(right).At(Precedence.LogicalAnd + 1), CsType.Bool, Precedence.LogicalAnd);
                case "||":
                    return new TypedCode(ToBoolCode(left).At(Precedence.LogicalOr) + " || " + ToBoolCode(right).At(Precedence.LogicalOr + 1), CsType.Bool, Precedence.LogicalOr);
                default:
                    throw new InvalidOperationException("unknown operator " + binary.Operator);
            }
        }

        /// <summary>a &amp; b &amp; c: every part as string, joined with +; empty string literals are dropped.</summary>
        private TypedCode Concatenation(BinaryNode binary)
        {
            List<Node> operands = new List<Node>();
            FlattenConcatenation(binary, operands);
            List<TypedCode> parts = new List<TypedCode>();
            bool afterString = false;
            foreach (Node operand in operands)
            {
                TypedCode translated = Translate(operand);
                // C# turns an int or long into text by itself once a string stands before it: "0" + count
                bool native = afterString && (translated.Type.Kind == TypeKind.Int || translated.Type.Kind == TypeKind.Long);
                TypedCode part = native ? translated : ToStringCode(translated);
                afterString = afterString || part.Type.Kind == TypeKind.String;
                if (!(part.IsLiteral && part.LiteralText.Length == 0))
                {
                    parts.Add(part);
                }
            }
            if (parts.Count == 0)
            {
                return Literal("\"\"", CsType.String, string.Empty);
            }
            if (parts.Count == 1)
            {
                return parts[0];
            }
            List<string> codes = new List<string>();
            foreach (TypedCode part in parts)
            {
                codes.Add(part.At(Precedence.Additive + 1));
            }
            return new TypedCode(string.Join(" + ", codes.ToArray()), CsType.String, Precedence.Additive);
        }

        private static void FlattenConcatenation(Node node, List<Node> operands)
        {
            BinaryNode binary = node as BinaryNode;
            if (binary != null && binary.Operator == "&")
            {
                FlattenConcatenation(binary.Left, operands);
                FlattenConcatenation(binary.Right, operands);
                return;
            }
            operands.Add(node);
        }

        private TypedCode Arithmetic(string op, TypedCode left, TypedCode right)
        {
            CsType type = CommonNumericType(left.Type, right.Type);
            TypedCode a;
            if (op == "/" && (type.Kind == TypeKind.Int || type.Kind == TypeKind.Long))
            {
                // MII divides as floating point, C# would divide integers
                type = CsType.Double;
                a = new TypedCode("(double)" + left.At(Precedence.Unary), CsType.Double, Precedence.Unary);
            }
            else
            {
                a = ToNumberOf(left, type);
            }
            TypedCode b = ToNumberOf(right, type);
            int precedence = op == "+" || op == "-" ? Precedence.Additive : Precedence.Multiplicative;
            return new TypedCode(a.At(precedence) + " " + op + " " + b.At(precedence + 1), type, precedence);
        }

        private TypedCode Relational(string op, TypedCode left, TypedCode right)
        {
            if (IsNumericOrUnknownNumber(left, right))
            {
                CsType type = CommonNumericType(left.Type, right.Type);
                return new TypedCode(ToNumberOf(left, type).At(Precedence.Relational + 1) + " " + op + " " + ToNumberOf(right, type).At(Precedence.Relational + 1), CsType.Bool, Precedence.Relational);
            }
            if (left.Type.Kind == TypeKind.DateTime && right.Type.Kind == TypeKind.DateTime)
            {
                return new TypedCode(left.At(Precedence.Relational + 1) + " " + op + " " + right.At(Precedence.Relational + 1), CsType.Bool, Precedence.Relational);
            }
            return new TypedCode("Mii.Compare(" + left.Code + ", " + right.Code + ") " + op + " 0", CsType.Bool, Precedence.Relational);
        }

        private static bool IsNumericOrUnknownNumber(TypedCode left, TypedCode right)
        {
            return (left.Type.IsNumeric && right.Type.IsNumeric)
                || (left.Type.IsNumeric && right.Type.Kind != TypeKind.String && right.Type.Kind != TypeKind.DateTime)
                || (right.Type.IsNumeric && left.Type.Kind != TypeKind.String && left.Type.Kind != TypeKind.DateTime);
        }

        private TypedCode Equality(string op, TypedCode left, TypedCode right)
        {
            bool same = (left.Type.Kind == TypeKind.String && right.Type.Kind == TypeKind.String)
                || (left.Type.Kind == TypeKind.Bool && right.Type.Kind == TypeKind.Bool)
                || (left.Type.Kind == TypeKind.DateTime && right.Type.Kind == TypeKind.DateTime);
            if (same)
            {
                return new TypedCode(left.At(Precedence.Equality + 1) + " " + op + " " + right.At(Precedence.Equality + 1), CsType.Bool, Precedence.Equality);
            }
            if (left.Type.IsNumeric && right.Type.IsNumeric)
            {
                CsType type = CommonNumericType(left.Type, right.Type);
                return new TypedCode(ToNumberOf(left, type).At(Precedence.Equality + 1) + " " + op + " " + ToNumberOf(right, type).At(Precedence.Equality + 1), CsType.Bool, Precedence.Equality);
            }
            string call = "Mii.AreEqual(" + left.Code + ", " + right.Code + ")";
            if (op == "==")
            {
                return TypedCode.Primary(call, CsType.Bool);
            }
            return new TypedCode("!" + call, CsType.Bool, Precedence.Unary);
        }

        private static CsType CommonNumericType(CsType left, CsType right)
        {
            if (left.Kind == TypeKind.Int && right.Kind == TypeKind.Int)
            {
                return CsType.Int;
            }
            if ((left.Kind == TypeKind.Int || left.Kind == TypeKind.Long) && (right.Kind == TypeKind.Int || right.Kind == TypeKind.Long))
            {
                return CsType.Long;
            }
            if (left.Kind == TypeKind.Decimal && right.Kind == TypeKind.Decimal)
            {
                return CsType.Decimal;
            }
            return CsType.Double;
        }

        private static TypedCode ToNumberOf(TypedCode value, CsType type)
        {
            if (value.Type.IsSameAs(type))
            {
                return value;
            }
            if (type.Kind == TypeKind.Long && value.Type.Kind == TypeKind.Int)
            {
                return value;
            }
            if (type.Kind == TypeKind.Double && (value.Type.Kind == TypeKind.Int || value.Type.Kind == TypeKind.Long))
            {
                return value;
            }
            if (type.Kind == TypeKind.Double && value.Type.Kind == TypeKind.Decimal)
            {
                return new TypedCode("(double)" + value.At(Precedence.Unary), CsType.Double, Precedence.Unary);
            }
            return ConvertTo(value, type);
        }

        private static TypedCode ToNumericCode(TypedCode value)
        {
            return value.Type.IsNumeric ? value : ConvertTo(value, CsType.Double);
        }

        private static TypedCode ToDoubleCode(TypedCode value)
        {
            return ToNumberOf(value, CsType.Double);
        }

        // ------------------------------------------------------------------ conversions

        public static TypedCode ToStringCode(TypedCode value)
        {
            return ConvertTo(value, CsType.String);
        }

        public static TypedCode ToBoolCode(TypedCode value)
        {
            return ConvertTo(value, CsType.Bool);
        }

        /// <summary>The value as the given type: unchanged when the types match (or C# converts implicitly), a Mii.To*
        /// conversion otherwise.</summary>
        public static TypedCode ConvertTo(TypedCode value, CsType target)
        {
            if (target.Kind == TypeKind.Object || value.Type.IsSameAs(target))
            {
                return value;
            }
            if (target.IsNumeric && value.Type.IsNumeric && ImplicitNumeric(value.Type.Kind, target.Kind))
            {
                return value;
            }
            switch (target.Kind)
            {
                case TypeKind.String:
                    if (value.IsLiteral && (value.Type.Kind == TypeKind.Int || value.Type.Kind == TypeKind.Long || value.Type.Kind == TypeKind.Bool))
                    {
                        return Literal(CsLiteral.String(value.LiteralText), CsType.String, value.LiteralText);
                    }
                    return Call("Mii.ToStr", value, CsType.String);
                case TypeKind.Bool:
                    return Call("Mii.ToBool", value, CsType.Bool);
                case TypeKind.Int:
                    return Call("Mii.ToInt", value, CsType.Int);
                case TypeKind.Long:
                    return Call("Mii.ToLong", value, CsType.Long);
                case TypeKind.Double:
                    return Call("Mii.ToDouble", value, CsType.Double);
                case TypeKind.Decimal:
                    return Call("Mii.ToDecimal", value, CsType.Decimal);
                case TypeKind.DateTime:
                    return Call("Mii.ToDateTime", value, CsType.DateTime);
                case TypeKind.List:
                    return Call("Mii.ToList", value, CsType.List);
                case TypeKind.Map:
                    return Call("Mii.ToMap", value, CsType.Map);
                case TypeKind.Xml:
                    if (value.XmlCode != null)
                    {
                        return TypedCode.Primary(value.XmlCode, CsType.Xml);
                    }
                    return Call("Mii.ToXml", value, CsType.Xml);
                case TypeKind.Rowset:
                    return TypedCode.Primary("Mii.ToRowset<" + target.Name + ">(" + (value.XmlCode ?? value.Code) + ")", target);
                case TypeKind.Row:
                    return TypedCode.Primary("Mii.ToRow<" + target.Name + ">(" + (value.XmlCode ?? value.Code) + ")", target);
                default:
                    return new TypedCode("(" + target.Name + ")" + value.At(Precedence.Unary), target, Precedence.Unary);
            }
        }

        private static bool ImplicitNumeric(TypeKind from, TypeKind to)
        {
            if (from == to)
            {
                return true;
            }
            if (from == TypeKind.Int)
            {
                return to == TypeKind.Long || to == TypeKind.Double || to == TypeKind.Decimal;
            }
            if (from == TypeKind.Long)
            {
                return to == TypeKind.Double || to == TypeKind.Decimal;
            }
            return false;
        }

        private static TypedCode Call(string method, TypedCode value, CsType type)
        {
            return TypedCode.Primary(method + "(" + value.Code + ")", type);
        }

        // ------------------------------------------------------------------ functions

        private TypedCode TranslateFunction(FunctionNode function)
        {
            List<Node> arguments = function.Arguments;
            switch (function.Name)
            {
                case "stringlength":
                    if (arguments.Count == 1)
                    {
                        return TypedCode.Primary(StringArgument(arguments[0]) + ".Length", CsType.Int);
                    }
                    break;
                case "stringupper":
                    if (arguments.Count == 1)
                    {
                        return TypedCode.Primary(StringArgument(arguments[0]) + ".ToUpperInvariant()", CsType.String);
                    }
                    break;
                case "stringlower":
                    if (arguments.Count == 1)
                    {
                        return TypedCode.Primary(StringArgument(arguments[0]) + ".ToLowerInvariant()", CsType.String);
                    }
                    break;
                case "stringtrim":
                    if (arguments.Count == 1)
                    {
                        return TypedCode.Primary(StringArgument(arguments[0]) + ".Trim()", CsType.String);
                    }
                    break;
                case "match":
                    if (arguments.Count == 2)
                    {
                        // case-sensitive on the system unless the pattern carries (?i)
                        return TypedCode.Primary("Regex.IsMatch(" + ToStringCode(Translate(arguments[0])).Code + ", " + ToStringCode(Translate(arguments[1])).Code + ")", CsType.Bool);
                    }
                    break;
                case "stringif":
                    if (arguments.Count == 3)
                    {
                        return new TypedCode(ToBoolCode(Translate(arguments[0])).At(Precedence.Conditional + 1) + " ? "
                            + ToStringCode(Translate(arguments[1])).At(Precedence.Conditional + 1) + " : "
                            + ToStringCode(Translate(arguments[2])).At(Precedence.Conditional), CsType.String, Precedence.Conditional);
                    }
                    break;
                case "if":
                case "objectif":
                    if (arguments.Count == 3)
                    {
                        return Conditional(arguments);
                    }
                    break;
                case "not":
                    if (arguments.Count == 1)
                    {
                        return new TypedCode("!" + ToBoolCode(Translate(arguments[0])).At(Precedence.Unary), CsType.Bool, Precedence.Unary);
                    }
                    break;
                case "and":
                case "or":
                    if (arguments.Count >= 2)
                    {
                        string op = function.Name == "and" ? " && " : " || ";
                        int precedence = function.Name == "and" ? Precedence.LogicalAnd : Precedence.LogicalOr;
                        List<string> parts = new List<string>();
                        foreach (Node argument in arguments)
                        {
                            parts.Add(ToBoolCode(Translate(argument)).At(precedence + 1));
                        }
                        return new TypedCode(string.Join(op, parts.ToArray()), CsType.Bool, precedence);
                    }
                    break;
                case "number":
                    if (arguments.Count == 1)
                    {
                        return ConvertTo(Translate(arguments[0]), CsType.Double);
                    }
                    break;
                case "abs":
                    if (arguments.Count == 1)
                    {
                        return TypedCode.Primary("Math.Abs(" + ToDoubleCode(Translate(arguments[0])).Code + ")", CsType.Double);
                    }
                    break;
                case "size":
                    if (arguments.Count == 1)
                    {
                        TypedCode collection = Translate(arguments[0]);
                        if (collection.Type.Kind == TypeKind.List || collection.Type.Kind == TypeKind.Map)
                        {
                            return TypedCode.Primary(collection.At(Precedence.Primary) + ".Count", CsType.Int);
                        }
                        return TypedCode.Primary("Mii.Size(" + collection.Code + ")", CsType.Int);
                    }
                    break;
                case "getvalue":
                    if (arguments.Count == 1)
                    {
                        TypedCode resolved = GetValueOfCatchSource(arguments[0]);
                        if (resolved != null)
                        {
                            return resolved;
                        }
                        _symbols.Note("getvalue() reads a property by a name built at runtime (not translatable)");
                    }
                    break;
            }
            return HelperCall(function);
        }

        private string StringArgument(Node argument)
        {
            return ToStringCode(Translate(argument)).At(Precedence.Primary);
        }

        private TypedCode Conditional(List<Node> arguments)
        {
            TypedCode condition = ToBoolCode(Translate(arguments[0]));
            TypedCode whenTrue = Translate(arguments[1]);
            TypedCode whenFalse = Translate(arguments[2]);
            CsType type = whenTrue.Type;
            if (!whenTrue.Type.IsSameAs(whenFalse.Type))
            {
                type = CsType.Object;
                whenTrue = new TypedCode("(object)" + whenTrue.At(Precedence.Unary), CsType.Object, Precedence.Unary);
            }
            return new TypedCode(condition.At(Precedence.Conditional + 1) + " ? " + whenTrue.At(Precedence.Conditional + 1) + " : " + whenFalse.At(Precedence.Conditional), type, Precedence.Conditional);
        }

        /// <summary>getvalue(CatchX.Source &amp; ".Message"): the message of the action that threw, i.e. the caught exception's message.</summary>
        private TypedCode GetValueOfCatchSource(Node argument)
        {
            BinaryNode binary = argument as BinaryNode;
            if (binary == null || binary.Operator != "&")
            {
                return null;
            }
            ReferenceNode source = binary.Left as ReferenceNode;
            StringNode suffix = binary.Right as StringNode;
            if (source == null || suffix == null || source.Selector != null || !source.Path.EndsWith(".Source", StringComparison.Ordinal) || suffix.Value != ".Message")
            {
                return null;
            }
            ReferenceNode message = new ReferenceNode();
            message.Path = source.Scope + ".Message";
            return _symbols.Resolve(message);
        }

        private TypedCode HelperCall(FunctionNode function)
        {
            HelperFunction helper;
            List<string> arguments = new List<string>();
            foreach (Node argument in function.Arguments)
            {
                arguments.Add(Translate(argument).Code);
            }
            if (Helpers.TryGetValue(function.Name, out helper))
            {
                return TypedCode.Primary(helper.Method + "(" + string.Join(", ", arguments.ToArray()) + ")", helper.ReturnType);
            }
            _symbols.Note("MII function " + function.Name + "() has no X-Ray equivalent; Mii.Function throws NotImplementedException");
            arguments.Insert(0, CsLiteral.String(function.Name));
            return TypedCode.Primary("Mii.Function(" + string.Join(", ", arguments.ToArray()) + ")", CsType.Object);
        }

        private sealed class HelperFunction
        {
            public string Method;
            public CsType ReturnType;
        }

        /// <summary>MII function -> Mii.* helper and its return type. The helpers take object arguments.</summary>
        private static Dictionary<string, HelperFunction> CreateHelpers()
        {
            Dictionary<string, HelperFunction> helpers = new Dictionary<string, HelperFunction>();
            Add(helpers, CsType.String,
                "stringleft", "StringLeft", "stringright", "StringRight", "stringpart", "StringPart",
                "stringreplace", "StringReplace", "stringreplaceall", "StringReplaceAll", "quotes", "Quotes",
                "encode", "Encode", "decode", "Decode", "base64encode", "Base64Encode", "base64decode", "Base64Decode",
                "booleantostring", "BooleanToString", "listtostring", "ListToString", "dateformat", "DateFormat",
                "formatdatenow", "FormatDateNow", "first", "First", "last", "Last", "getvaluefrommap", "GetValueFromMap",
                "name", "Name", "xmlencode", "XmlEncode", "xmldecode", "XmlDecode", "format", "Format", "getvalue", "GetValue");
            Add(helpers, CsType.Int,
                "stringindexof", "StringIndexOf", "stringlastindexof", "StringLastIndexOf", "find", "Find", "datecompare", "DateCompare");
            Add(helpers, CsType.Long,
                "datediff", "DateDiff", "datediffdays", "DateDiffDays", "datediffhours", "DateDiffHours",
                "datediffminutes", "DateDiffMinutes", "datetoseconds", "DateToSeconds");
            Add(helpers, CsType.Double,
                "round", "Round", "min", "Min", "max", "Max", "sum", "Sum", "average", "Average",
                "ceiling", "Ceiling", "floor", "Floor", "sqrt", "Sqrt", "random", "Random");
            Add(helpers, CsType.Bool,
                "match2", "Match2", "containskey", "ContainsKey", "containsvalue", "ContainsValue",
                "stringtoboolean", "ToBool", "datebetween", "DateBetween", "match", "Match");
            Add(helpers, CsType.List,
                "list", "List", "stringtolist", "StringToList", "stringtolistwithlimit", "StringToListWithLimit",
                "append", "Append", "insert", "Insert", "set", "Set", "remove", "Remove", "keys", "Keys", "values", "Values",
                "getlistfromxpath", "GetListFromXPath", "sort", "Sort");
            Add(helpers, CsType.Map,
                "map", "Map", "put", "Put", "liststomap", "ListsToMap", "getmapfromxpath", "GetMapFromXPath");
            Add(helpers, CsType.DateTime,
                "dateaddseconds", "DateAddSeconds", "dateaddminutes", "DateAddMinutes", "dateaddhours", "DateAddHours",
                "dateadddays", "DateAddDays", "dateaddmonths", "DateAddMonths", "dateaddyears", "DateAddYears",
                "converttimezone", "ConvertTimeZone", "converttimezone2", "ConvertTimeZone2",
                "datefromxmlformat", "ToDateTime", "datefromseconds", "DateFromSeconds");
            return helpers;
        }

        /// <summary>Pairs of MII function name and Mii.* method name.</summary>
        private static void Add(Dictionary<string, HelperFunction> helpers, CsType type, params string[] pairs)
        {
            for (int index = 0; index + 1 < pairs.Length; index += 2)
            {
                HelperFunction helper = new HelperFunction();
                helper.Method = "Mii." + pairs[index + 1];
                helper.ReturnType = type;
                helpers[pairs[index]] = helper;
            }
        }

        private static string OneLine(string text)
        {
            string value = (text ?? string.Empty).Replace("\r", " ").Replace("\n", " ");
            return value.Length > 120 ? value.Substring(0, 120) + "..." : value;
        }
    }
}

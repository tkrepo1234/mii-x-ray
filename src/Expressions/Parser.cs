using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace MiiXRay.Expressions
{
    /// <summary>Parses MII link expressions. Operator precedence as documented by SAP (guide p. 199-201), lowest first:
    /// equality (== !=), or (|| or), and (&amp;&amp; and), relational (&lt; &gt; &lt;= &gt;=), concatenation (&amp;),
    /// additive (+ -), multiplicative (* / %), exponent (^), unary (- !), primary.
    /// Note the two surprises: &amp; binds tighter than comparisons and equality binds weakest.</summary>
    public sealed class Parser
    {
        private static readonly Regex InterpolatedReference = new Regex(@"#([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)#", RegexOptions.Compiled);

        private static readonly string[] Keywords =
        {
            "cr", "lf", "crlf", "tab", "doublequote", "singlequote", "datenow", "today", "dateformat", "dateoffsetformat",
            "datetimezoneformat", "currenttimezone", "currenttimeoffset", "timezoneids", "emptylist", "emptymap", "nullstring",
            "nulldate", "nullnumber", "guid", "transactionid", "e", "pi", "username", "transactionpath", "currenttimemillis",
            "userlocale", "currenttimezoneoffset"
        };

        private readonly List<Token> _tokens;
        private int _index;

        private Parser(List<Token> tokens)
        {
            _tokens = tokens;
        }

        public static Node Parse(string expression)
        {
            if (expression == null || expression.Trim().Length == 0)
            {
                return new EmptyNode();
            }
            Parser parser = new Parser(new Lexer(expression).Tokenize());
            if (parser.Current.Kind == TokenKind.End)
            {
                // only a comment
                return new EmptyNode();
            }
            Node node = parser.ParseEquality();
            if (parser.Current.Kind != TokenKind.End)
            {
                throw new ExpressionException("unexpected " + parser.Current + " at position " + parser.Current.Position);
            }
            return node;
        }

        public static bool IsKeyword(string name)
        {
            foreach (string keyword in Keywords)
            {
                if (string.Equals(keyword, name, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private Token Current
        {
            get { return _tokens[_index]; }
        }

        private Token Peek(int offset)
        {
            int position = Math.Min(_index + offset, _tokens.Count - 1);
            return _tokens[position];
        }

        private bool IsOperator(params string[] operators)
        {
            Token token = Current;
            foreach (string op in operators)
            {
                if (token.Kind == TokenKind.Operator && token.Text == op)
                {
                    return true;
                }
                // the word operators "and" / "or" (not followed by "(", which would be the function)
                if (token.Kind == TokenKind.Identifier && string.Equals(token.Text, op, StringComparison.OrdinalIgnoreCase)
                    && Peek(1).Kind != TokenKind.LeftParen)
                {
                    return true;
                }
            }
            return false;
        }

        private string TakeOperator()
        {
            string text = Current.Text.ToLowerInvariant();
            _index++;
            if (text == "and")
            {
                return "&&";
            }
            if (text == "or")
            {
                return "||";
            }
            return text;
        }

        private Node ParseEquality()
        {
            Node left = ParseOr();
            while (IsOperator("==", "!="))
            {
                left = Binary(TakeOperator(), left, ParseOr());
            }
            return left;
        }

        private Node ParseOr()
        {
            Node left = ParseAnd();
            while (IsOperator("||", "or"))
            {
                left = Binary(TakeOperator(), left, ParseAnd());
            }
            return left;
        }

        private Node ParseAnd()
        {
            Node left = ParseRelational();
            while (IsOperator("&&", "and"))
            {
                left = Binary(TakeOperator(), left, ParseRelational());
            }
            return left;
        }

        private Node ParseRelational()
        {
            Node left = ParseConcat();
            while (IsOperator("<", ">", "<=", ">="))
            {
                left = Binary(TakeOperator(), left, ParseConcat());
            }
            return left;
        }

        private Node ParseConcat()
        {
            Node left = ParseAdditive();
            while (IsOperator("&"))
            {
                left = Binary(TakeOperator(), left, ParseAdditive());
            }
            return left;
        }

        private Node ParseAdditive()
        {
            Node left = ParseMultiplicative();
            while (IsOperator("+", "-"))
            {
                left = Binary(TakeOperator(), left, ParseMultiplicative());
            }
            return left;
        }

        private Node ParseMultiplicative()
        {
            Node left = ParseExponent();
            while (IsOperator("*", "/", "%"))
            {
                left = Binary(TakeOperator(), left, ParseExponent());
            }
            return left;
        }

        private Node ParseExponent()
        {
            Node left = ParseUnary();
            if (IsOperator("^"))
            {
                TakeOperator();
                return Binary("^", left, ParseExponent());
            }
            return left;
        }

        private Node ParseUnary()
        {
            if (IsOperator("-", "!"))
            {
                UnaryNode unary = new UnaryNode();
                unary.Operator = TakeOperator();
                unary.Operand = ParseUnary();
                return unary;
            }
            return ParsePrimary();
        }

        private Node ParsePrimary()
        {
            Token token = Current;
            switch (token.Kind)
            {
                case TokenKind.String:
                    _index++;
                    return StringWithInterpolation(token.Text);
                case TokenKind.Number:
                    _index++;
                    NumberNode number = new NumberNode();
                    number.Text = token.Text;
                    return number;
                case TokenKind.LeftParen:
                    _index++;
                    Node inner = ParseEquality();
                    Expect(TokenKind.RightParen);
                    return inner;
                case TokenKind.Dynamic:
                    _index++;
                    DynamicNode dynamic = new DynamicNode();
                    dynamic.Text = token.Text;
                    return dynamic;
                case TokenKind.ListLiteral:
                    _index++;
                    ListLiteralNode list = new ListLiteralNode();
                    list.Text = token.Text;
                    return list;
                case TokenKind.Identifier:
                    return ParseIdentifier();
                default:
                    throw new ExpressionException("unexpected " + token + " at position " + token.Position);
            }
        }

        private Node ParseIdentifier()
        {
            Token token = Current;
            _index++;
            if (Current.Kind == TokenKind.LeftParen && token.Text.IndexOf('.') < 0)
            {
                _index++;
                FunctionNode function = new FunctionNode();
                function.Name = token.Text.ToLowerInvariant();
                if (Current.Kind != TokenKind.RightParen)
                {
                    function.Arguments.Add(ParseEquality());
                    while (Current.Kind == TokenKind.Comma)
                    {
                        _index++;
                        function.Arguments.Add(ParseEquality());
                    }
                }
                Expect(TokenKind.RightParen);
                return function;
            }
            if (token.Text.IndexOf('.') < 0)
            {
                string lower = token.Text.ToLowerInvariant();
                if (lower == "true" || lower == "false")
                {
                    BooleanNode boolean = new BooleanNode();
                    boolean.Value = lower == "true";
                    return boolean;
                }
                if (IsKeyword(lower))
                {
                    KeywordNode keyword = new KeywordNode();
                    keyword.Name = lower;
                    return keyword;
                }
            }
            ReferenceNode reference = new ReferenceNode();
            reference.Path = token.Text;
            if (Current.Kind == TokenKind.Selector)
            {
                reference.Selector = Current.Text;
                _index++;
            }
            return reference;
        }

        /// <summary>"#Local.A# -> #Local.B#": references between hashes inside a string are evaluated (dynamic scope).
        /// Only #Scope.Name# patterns are taken as references; a lone # (e.g. in a regex) stays text.</summary>
        private static Node StringWithInterpolation(string value)
        {
            MatchCollection matches = InterpolatedReference.Matches(value);
            if (matches.Count == 0)
            {
                return Text(value);
            }
            Node result = null;
            int last = 0;
            foreach (Match match in matches)
            {
                if (match.Index > last)
                {
                    result = Append(result, Text(value.Substring(last, match.Index - last)));
                }
                ReferenceNode reference = new ReferenceNode();
                reference.Path = match.Groups[1].Value;
                result = Append(result, reference);
                last = match.Index + match.Length;
            }
            if (last < value.Length)
            {
                result = Append(result, Text(value.Substring(last)));
            }
            if (!(result is BinaryNode))
            {
                result = Binary("&", Text(string.Empty), result);
            }
            return result;
        }

        private static Node Append(Node left, Node right)
        {
            return left == null ? right : Binary("&", left, right);
        }

        private static StringNode Text(string value)
        {
            StringNode node = new StringNode();
            node.Value = value;
            return node;
        }

        private static BinaryNode Binary(string op, Node left, Node right)
        {
            BinaryNode node = new BinaryNode();
            node.Operator = op;
            node.Left = left;
            node.Right = right;
            return node;
        }

        private void Expect(TokenKind kind)
        {
            if (Current.Kind != kind)
            {
                throw new ExpressionException("expected " + kind + " but found " + Current + " at position " + Current.Position);
            }
            _index++;
        }
    }
}

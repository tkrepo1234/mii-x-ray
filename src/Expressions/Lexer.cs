using System;
using System.Collections.Generic;
using System.Text;

namespace MiiXRay.Expressions
{
    public enum TokenKind
    {
        String,
        Number,
        Identifier,
        Selector,
        Operator,
        LeftParen,
        RightParen,
        Comma,
        Dynamic,
        ListLiteral,
        End
    }

    public sealed class Token
    {
        public TokenKind Kind;
        /// <summary>The value: string contents (unescaped), number text, identifier, operator, raw selector/dynamic/list text.</summary>
        public string Text;
        public int Position;

        public override string ToString()
        {
            return Kind + " '" + Text + "'";
        }
    }

    public sealed class ExpressionException : Exception
    {
        public ExpressionException(string message)
            : base(message)
        {
        }
    }

    /// <summary>Splits an MII link expression into tokens. Selectors ({xpath}, {key}), dynamic scopes (#expr#) and
    /// list literals ([[string:a]]) are kept as raw text.</summary>
    public sealed class Lexer
    {
        private static readonly string[] Operators = { "==", "!=", "<=", ">=", "&&", "||", "&", "+", "-", "*", "/", "%", "^", "!", "<", ">", "=" };

        private readonly string _text;
        private int _position;

        public Lexer(string text)
        {
            _text = text ?? string.Empty;
        }

        public List<Token> Tokenize()
        {
            List<Token> tokens = new List<Token>();
            while (true)
            {
                SkipSpaceAndComments();
                if (_position >= _text.Length)
                {
                    tokens.Add(Make(TokenKind.End, string.Empty, _position));
                    return tokens;
                }
                tokens.Add(Next());
            }
        }

        private Token Next()
        {
            int start = _position;
            char c = _text[_position];
            if (c == '"')
            {
                return Make(TokenKind.String, ReadString(), start);
            }
            if (char.IsDigit(c) || (c == '.' && _position + 1 < _text.Length && char.IsDigit(_text[_position + 1])))
            {
                return Make(TokenKind.Number, ReadNumber(), start);
            }
            if (char.IsLetter(c) || c == '_')
            {
                return Make(TokenKind.Identifier, ReadIdentifier(), start);
            }
            if (c == '{')
            {
                return Make(TokenKind.Selector, ReadBalanced('{', '}'), start);
            }
            if (c == '[')
            {
                return Make(TokenKind.ListLiteral, "[" + ReadBalanced('[', ']') + "]", start);
            }
            if (c == '#')
            {
                int end = _text.IndexOf('#', _position + 1);
                if (end < 0)
                {
                    throw new ExpressionException("unterminated #...# at position " + start);
                }
                string inner = _text.Substring(_position + 1, end - _position - 1);
                _position = end + 1;
                return Make(TokenKind.Dynamic, inner, start);
            }
            if (c == '(')
            {
                _position++;
                return Make(TokenKind.LeftParen, "(", start);
            }
            if (c == ')')
            {
                _position++;
                return Make(TokenKind.RightParen, ")", start);
            }
            if (c == ',')
            {
                _position++;
                return Make(TokenKind.Comma, ",", start);
            }
            foreach (string op in Operators)
            {
                if (string.CompareOrdinal(_text, _position, op, 0, op.Length) == 0)
                {
                    _position += op.Length;
                    return Make(TokenKind.Operator, op == "=" ? "==" : op, start);
                }
            }
            throw new ExpressionException("unexpected character '" + c + "' at position " + start);
        }

        private void SkipSpaceAndComments()
        {
            while (_position < _text.Length)
            {
                if (char.IsWhiteSpace(_text[_position]))
                {
                    _position++;
                }
                else if (_position + 1 < _text.Length && _text[_position] == '/' && _text[_position + 1] == '*')
                {
                    int end = _text.IndexOf("*/", _position + 2, StringComparison.Ordinal);
                    _position = end < 0 ? _text.Length : end + 2;
                }
                else
                {
                    return;
                }
            }
        }

        private string ReadString()
        {
            StringBuilder value = new StringBuilder();
            _position++;
            while (_position < _text.Length)
            {
                char c = _text[_position];
                if (c == '\\' && _position + 1 < _text.Length && (_text[_position + 1] == '"' || _text[_position + 1] == '\\'))
                {
                    value.Append(_text[_position + 1]);
                    _position += 2;
                }
                else if (c == '"')
                {
                    _position++;
                    return value.ToString();
                }
                else
                {
                    value.Append(c);
                    _position++;
                }
            }
            throw new ExpressionException("unterminated string literal");
        }

        private string ReadNumber()
        {
            int start = _position;
            while (_position < _text.Length && (char.IsDigit(_text[_position]) || _text[_position] == '.'))
            {
                _position++;
            }
            if (_position < _text.Length && (_text[_position] == 'e' || _text[_position] == 'E')
                && _position + 1 < _text.Length && (char.IsDigit(_text[_position + 1]) || _text[_position + 1] == '-' || _text[_position + 1] == '+'))
            {
                _position += 2;
                while (_position < _text.Length && char.IsDigit(_text[_position]))
                {
                    _position++;
                }
            }
            return _text.Substring(start, _position - start);
        }

        private string ReadIdentifier()
        {
            int start = _position;
            while (_position < _text.Length)
            {
                char c = _text[_position];
                if (char.IsLetterOrDigit(c) || c == '_')
                {
                    _position++;
                }
                else if (c == '.' && _position + 1 < _text.Length && (char.IsLetterOrDigit(_text[_position + 1]) || _text[_position + 1] == '_'))
                {
                    _position++;
                }
                else
                {
                    break;
                }
            }
            return _text.Substring(start, _position - start);
        }

        /// <summary>Reads from an opening bracket to its matching closing bracket and returns the text between them.
        /// Quotes inside are respected, so an XPath predicate like [Name = '}'] does not end the selector.</summary>
        private string ReadBalanced(char open, char close)
        {
            int start = _position + 1;
            int depth = 0;
            char quote = '\0';
            while (_position < _text.Length)
            {
                char c = _text[_position];
                if (quote != '\0')
                {
                    if (c == quote)
                    {
                        quote = '\0';
                    }
                }
                else if ((c == '\'' || c == '"') && open == '{')
                {
                    quote = c;
                }
                else if (c == open)
                {
                    depth++;
                }
                else if (c == close)
                {
                    depth--;
                    if (depth == 0)
                    {
                        string inner = _text.Substring(start, _position - start);
                        _position++;
                        return inner;
                    }
                }
                _position++;
            }
            throw new ExpressionException("unterminated " + open + "..." + close);
        }

        private static Token Make(TokenKind kind, string text, int position)
        {
            Token token = new Token();
            token.Kind = kind;
            token.Text = text;
            token.Position = position;
            return token;
        }
    }
}

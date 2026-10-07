using System.Collections.Generic;
using System.Text;

namespace MiiXRay.Generate
{
    /// <summary>Reads MII list and map literals: [[string:a], [string:b]] and {Key=[string:value], K2=[double:1.0]}.</summary>
    public static class ValueLiteral
    {
        public static List<string> ParseList(string text)
        {
            List<string> values = new List<string>();
            string trimmed = (text ?? string.Empty).Trim();
            if (trimmed.Length < 2 || trimmed[0] != '[')
            {
                return values;
            }
            int position = 1;
            while (position < trimmed.Length - 1)
            {
                int open = trimmed.IndexOf('[', position);
                if (open < 0)
                {
                    break;
                }
                int end;
                values.Add(ReadTypedValue(trimmed, open, out end));
                position = end + 1;
            }
            return values;
        }

        /// <summary>Key/value pairs in literal order.</summary>
        public static List<KeyValuePair<string, string>> ParseMap(string text)
        {
            List<KeyValuePair<string, string>> pairs = new List<KeyValuePair<string, string>>();
            string trimmed = (text ?? string.Empty).Trim();
            if (trimmed.Length < 2 || trimmed[0] != '{')
            {
                return pairs;
            }
            int position = 1;
            while (position < trimmed.Length - 1)
            {
                int equals = trimmed.IndexOf('=', position);
                if (equals < 0)
                {
                    break;
                }
                string key = trimmed.Substring(position, equals - position).Trim().TrimStart(',').Trim();
                int open = equals + 1;
                while (open < trimmed.Length && trimmed[open] == ' ')
                {
                    open++;
                }
                if (open >= trimmed.Length || trimmed[open] != '[')
                {
                    break;
                }
                int end;
                string value = ReadTypedValue(trimmed, open, out end);
                pairs.Add(new KeyValuePair<string, string>(key, value));
                position = end + 1;
            }
            return pairs;
        }

        /// <summary>Reads "[type:value]" starting at the opening bracket; brackets inside the value are balanced.</summary>
        private static string ReadTypedValue(string text, int open, out int end)
        {
            int depth = 0;
            int position = open;
            while (position < text.Length)
            {
                if (text[position] == '[')
                {
                    depth++;
                }
                else if (text[position] == ']')
                {
                    depth--;
                    if (depth == 0)
                    {
                        break;
                    }
                }
                position++;
            }
            end = position;
            string inner = text.Substring(open + 1, System.Math.Max(0, position - open - 1));
            int colon = inner.IndexOf(':');
            return colon >= 0 ? inner.Substring(colon + 1) : inner;
        }

        /// <summary>C# code for a list default: Mii.List("a", "b") or new List&lt;string&gt;().</summary>
        public static string ListCode(string text)
        {
            List<string> values = ParseList(text);
            if (values.Count == 0)
            {
                return "new List<string>()";
            }
            StringBuilder code = new StringBuilder("Mii.List(");
            for (int index = 0; index < values.Count; index++)
            {
                if (index > 0)
                {
                    code.Append(", ");
                }
                code.Append(CsLiteral.String(values[index]));
            }
            return code.Append(')').ToString();
        }

        /// <summary>C# code for a map default: Mii.Map("Key", "value", ...) or new Dictionary&lt;string, string&gt;().</summary>
        public static string MapCode(string text)
        {
            List<KeyValuePair<string, string>> pairs = ParseMap(text);
            if (pairs.Count == 0)
            {
                return "new Dictionary<string, string>()";
            }
            StringBuilder code = new StringBuilder("Mii.Map(");
            for (int index = 0; index < pairs.Count; index++)
            {
                if (index > 0)
                {
                    code.Append(", ");
                }
                code.Append(CsLiteral.String(pairs[index].Key)).Append(", ").Append(CsLiteral.String(pairs[index].Value));
            }
            return code.Append(')').ToString();
        }
    }
}

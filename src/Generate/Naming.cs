using System;
using System.Collections.Generic;
using System.Text;

namespace MiiXRay.Generate
{
    /// <summary>C# identifiers from MII names.</summary>
    public static class Naming
    {
        private static readonly HashSet<string> Keywords = new HashSet<string>(new string[]
        {
            "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "checked", "class", "const", "continue",
            "decimal", "default", "delegate", "do", "double", "else", "enum", "event", "explicit", "extern", "false", "finally",
            "fixed", "float", "for", "foreach", "goto", "if", "implicit", "in", "int", "interface", "internal", "is", "lock",
            "long", "namespace", "new", "null", "object", "operator", "out", "override", "params", "private", "protected",
            "public", "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof", "stackalloc", "static", "string",
            "struct", "switch", "this", "throw", "true", "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort",
            "using", "virtual", "void", "volatile", "while"
        });

        /// <summary>Letters, digits and underscores only; never starts with a digit; never empty.</summary>
        public static string Sanitize(string name)
        {
            StringBuilder result = new StringBuilder();
            bool upperNext = false;
            foreach (char c in name ?? string.Empty)
            {
                if (char.IsLetterOrDigit(c) || c == '_')
                {
                    result.Append(upperNext ? char.ToUpperInvariant(c) : c);
                    upperNext = false;
                }
                else
                {
                    upperNext = result.Length > 0;
                }
            }
            if (result.Length == 0)
            {
                result.Append("Value");
            }
            if (char.IsDigit(result[0]))
            {
                result.Insert(0, '_');
            }
            return result.ToString();
        }

        public static bool IsValidIdentifier(string name)
        {
            return !string.IsNullOrEmpty(name) && Sanitize(name) == name && !Keywords.Contains(name);
        }

        public static string Pascal(string name)
        {
            string clean = Sanitize(name);
            string result = char.ToUpperInvariant(clean[0]) + clean.Substring(1);
            return Keywords.Contains(result) ? "@" + result : result;
        }

        public static string Camel(string name)
        {
            string clean = Sanitize(name);
            int upper = 0;
            while (upper < clean.Length && char.IsUpper(clean[upper]))
            {
                upper++;
            }
            string result;
            if (upper <= 1)
            {
                result = char.ToLowerInvariant(clean[0]) + clean.Substring(1);
            }
            else if (upper == clean.Length)
            {
                result = clean.ToLowerInvariant();
            }
            else
            {
                // "SFCNumber" -> "sfcNumber"
                result = clean.Substring(0, upper - 1).ToLowerInvariant() + clean.Substring(upper - 1);
            }
            return Keywords.Contains(result) ? result + "Value" : result;
        }
    }

    /// <summary>Hands out unique names inside one C# scope (a class or a method).</summary>
    public sealed class UniqueNames
    {
        private readonly HashSet<string> _used = new HashSet<string>(StringComparer.Ordinal);

        public void Reserve(string name)
        {
            _used.Add(name);
        }

        public bool IsUsed(string name)
        {
            return _used.Contains(name);
        }

        public string Claim(string wanted)
        {
            string name = wanted;
            int counter = 2;
            while (_used.Contains(name))
            {
                name = wanted + counter;
                counter++;
            }
            _used.Add(name);
            return name;
        }
    }
}

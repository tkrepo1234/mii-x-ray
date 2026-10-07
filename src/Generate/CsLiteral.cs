using System;
using System.Globalization;
using System.Text;

namespace MiiXRay.Generate
{
    /// <summary>C# literals.</summary>
    public static class CsLiteral
    {
        /// <summary>A string literal: regular with escapes, or verbatim (@"...") for long multi-line text such as SQL or XML.</summary>
        public static string String(string value)
        {
            if (value == null)
            {
                return "null";
            }

            bool multiLine = value.IndexOf('\n') >= 0;

            if (multiLine && value.Length > 60 && !HasOtherControlCharacters(value))
            {
                return "@\"" + value.Replace("\r\n", "\n").Replace("\r", "\n").Replace("\n", Environment.NewLine).Replace("\"", "\"\"") + "\"";
            }

            StringBuilder result = new StringBuilder("\"");

            foreach (char c in value)
            {
                switch (c)
                {
                    case '\\': result.Append("\\\\"); break;
                    case '"': result.Append("\\\""); break;
                    case '\r': result.Append("\\r"); break;
                    case '\n': result.Append("\\n"); break;
                    case '\t': result.Append("\\t"); break;
                    case '\0': result.Append("\\0"); break;
                    default:
                        if (char.IsControl(c) || c == (char)0x2028 || c == (char)0x2029)
                        {
                            result.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            result.Append(c);
                        }

                        break;
                }
            }

            result.Append('"');
            return result.ToString();
        }

        private static bool HasOtherControlCharacters(string value)
        {
            foreach (char c in value)
            {
                if (char.IsControl(c) && c != '\r' && c != '\n' && c != '\t')
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>A number literal of the given kind from MII text; "0" when the text is no number.</summary>
        public static string Number(string text, TypeKind kind)
        {
            double value;
            string trimmed = (text ?? string.Empty).Trim();

            if (!double.TryParse(trimmed, NumberStyles.Float, CultureInfo.InvariantCulture, out value) || double.IsNaN(value) || double.IsInfinity(value))
            {
                value = 0;
            }

            switch (kind)
            {
                case TypeKind.Int:
                    if (value >= int.MinValue && value <= int.MaxValue)
                    {
                        return ((int)Math.Truncate(value)).ToString(CultureInfo.InvariantCulture);
                    }

                    return "0";
                case TypeKind.Long:
                    if (value >= long.MinValue && value <= long.MaxValue)
                    {
                        long parsed;

                        if (long.TryParse(trimmed, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
                        {
                            return parsed.ToString(CultureInfo.InvariantCulture) + "L";
                        }

                        return ((long)Math.Truncate(value)).ToString(CultureInfo.InvariantCulture) + "L";
                    }

                    return "0L";
                case TypeKind.Decimal:
                    return value.ToString("R", CultureInfo.InvariantCulture) + "m";
                default:
                    string result = value.ToString("R", CultureInfo.InvariantCulture);

                    if (result.IndexOf('.') < 0 && result.IndexOf('E') < 0)
                    {
                        result += ".0";
                    }

                    return result;
            }
        }

        public static bool IsTrue(string text)
        {
            string trimmed = (text ?? string.Empty).Trim();
            return string.Equals(trimmed, "true", StringComparison.OrdinalIgnoreCase) || trimmed == "1";
        }

        /// <summary>new DateTime(...) for an MII date (yyyy-MM-ddTHH:mm:ss); DateTime.MinValue when empty or unreadable.</summary>
        public static string DateTimeValue(string text)
        {
            DateTime value;
            string[] formats = { "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss.fff", "yyyy-MM-dd'T'HH:mm:ssK", "yyyy-MM-dd" };

            if (DateTime.TryParseExact((text ?? string.Empty).Trim(), formats, CultureInfo.InvariantCulture, DateTimeStyles.None, out value))
            {
                if (value.TimeOfDay == TimeSpan.Zero)
                {
                    return string.Format(CultureInfo.InvariantCulture, "new DateTime({0}, {1}, {2})", value.Year, value.Month, value.Day);
                }

                return string.Format(CultureInfo.InvariantCulture, "new DateTime({0}, {1}, {2}, {3}, {4}, {5})",
                    value.Year, value.Month, value.Day, value.Hour, value.Minute, value.Second);
            }

            return "DateTime.MinValue";
        }
    }
}

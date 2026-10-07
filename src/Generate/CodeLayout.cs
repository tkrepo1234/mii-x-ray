using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace MiiXRay.Generate
{
    /// <summary>Blank lines of the generated code:
    /// after a closing brace a blank line, unless the enclosing block ends there or else/catch/finally follows;
    /// before a loop, condition, try, switch, using or lock a blank line, unless it starts its block or a blank line is
    /// already there. Comment lines directly above a statement stay with it.</summary>
    public static class CodeLayout
    {
        private static readonly Regex ControlStatement = new Regex(@"^((if|for|foreach|while|do|try|switch|lock)(\s|\(|$)|using\s*\()", RegexOptions.Compiled);
        private static readonly Regex Continuation = new Regex(@"^(else|catch|finally|while)(\s|\(|$)", RegexOptions.Compiled);

        public static List<string> AddBlankLines(List<string> lines)
        {
            List<string> result = new List<string>(lines.Count + lines.Count / 4);

            foreach (string line in lines)
            {
                string text = line.Trim();

                if (text.Length > 0 && result.Count > 0)
                {
                    string previous = result[result.Count - 1].Trim();

                    if (IsBlockEnd(previous) && !text.StartsWith("}", StringComparison.Ordinal) && !Continuation.IsMatch(text))
                    {
                        result.Add(string.Empty);
                    }
                    else if (ControlStatement.IsMatch(text))
                    {
                        InsertBlankBeforeComments(result);
                    }
                }

                result.Add(line);
            }

            return result;
        }

        private static bool IsBlockEnd(string text)
        {
            return text == "}" || text == "};" || text == "});";
        }

        private static void InsertBlankBeforeComments(List<string> result)
        {
            int index = result.Count;

            while (index > 0 && IsComment(result[index - 1].Trim()))
            {
                index--;
            }

            if (index == 0)
            {
                return;
            }

            string above = result[index - 1].Trim();

            if (above.Length == 0 || above.EndsWith("{", StringComparison.Ordinal) || above.EndsWith(":", StringComparison.Ordinal))
            {
                return;
            }

            result.Insert(index, string.Empty);
        }

        private static bool IsComment(string text)
        {
            return text.StartsWith("//", StringComparison.Ordinal) && !text.StartsWith("///", StringComparison.Ordinal);
        }
    }
}

using System;
using System.Collections.Generic;
using System.Text;

namespace MiiXRay.Generate
{
    /// <summary>Finds the result column names of an SQL statement: the select list of the last SELECT statement
    /// (aliases, dotted names, quoted names). A best effort: "*" and expressions without alias yield nothing.</summary>
    public static class SqlColumns
    {
        private static readonly HashSet<string> NotAnAlias = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "END", "AS", "DISTINCT", "ALL", "NULL", "AND", "OR", "NOT", "THEN", "ELSE", "WHEN", "CASE", "FROM", "ASC", "DESC", "IS"
        };

        public static List<string> Extract(string sql)
        {
            List<string> result = new List<string>();
            if (string.IsNullOrEmpty(sql))
            {
                return result;
            }
            List<string> tokens = Tokenize(sql);
            List<string> statement = LastSelectStatement(tokens);
            if (statement == null)
            {
                return result;
            }
            foreach (List<string> item in SelectItems(statement))
            {
                string name = ColumnName(item);
                if (name != null && !result.Contains(name))
                {
                    result.Add(name);
                }
            }
            return result;
        }

        /// <summary>Tokens: words, quoted names ("..."), strings ('...' as one token), single symbols. Comments are dropped.</summary>
        private static List<string> Tokenize(string sql)
        {
            List<string> tokens = new List<string>();
            int position = 0;
            while (position < sql.Length)
            {
                char c = sql[position];
                if (char.IsWhiteSpace(c))
                {
                    position++;
                }
                else if (c == '-' && position + 1 < sql.Length && sql[position + 1] == '-')
                {
                    int end = sql.IndexOf('\n', position);
                    position = end < 0 ? sql.Length : end + 1;
                }
                else if (c == '/' && position + 1 < sql.Length && sql[position + 1] == '*')
                {
                    int end = sql.IndexOf("*/", position + 2, StringComparison.Ordinal);
                    position = end < 0 ? sql.Length : end + 2;
                }
                else if (c == '\'' || c == '"')
                {
                    int end = position + 1;
                    while (end < sql.Length)
                    {
                        if (sql[end] == c)
                        {
                            if (end + 1 < sql.Length && sql[end + 1] == c)
                            {
                                end += 2;
                                continue;
                            }
                            break;
                        }
                        end++;
                    }
                    tokens.Add(sql.Substring(position, Math.Min(end + 1, sql.Length) - position));
                    position = end + 1;
                }
                else if (c == '[')
                {
                    // MII parameter slots [Param.N] and other bracket text
                    int end = sql.IndexOf(']', position);
                    end = end < 0 ? sql.Length - 1 : end;
                    tokens.Add(sql.Substring(position, end - position + 1));
                    position = end + 1;
                }
                else if (char.IsLetterOrDigit(c) || c == '_' || c == '$' || c == ':' || c == '#' || c == '@')
                {
                    int end = position;
                    while (end < sql.Length && (char.IsLetterOrDigit(sql[end]) || sql[end] == '_' || sql[end] == '$' || sql[end] == ':' || sql[end] == '#' || sql[end] == '@'))
                    {
                        end++;
                    }
                    tokens.Add(sql.Substring(position, end - position));
                    position = end;
                }
                else
                {
                    tokens.Add(c.ToString());
                    position++;
                }
            }
            return tokens;
        }

        /// <summary>The tokens of the last statement (split on ';' at depth 0) that starts with SELECT or WITH and is no
        /// SELECT ... INTO; inside a HANA DO BEGIN ... END block the statements are searched the same way.</summary>
        private static List<string> LastSelectStatement(List<string> tokens)
        {
            List<List<string>> statements = new List<List<string>>();
            List<string> current = new List<string>();
            int depth = 0;
            foreach (string token in tokens)
            {
                if (token == "(")
                {
                    depth++;
                }
                else if (token == ")")
                {
                    depth--;
                }
                if (token == ";" && depth <= 0)
                {
                    statements.Add(current);
                    current = new List<string>();
                    continue;
                }
                current.Add(token);
            }
            statements.Add(current);

            for (int index = statements.Count - 1; index >= 0; index--)
            {
                List<string> statement = TrimBlockKeywords(statements[index]);
                if (statement.Count == 0)
                {
                    continue;
                }
                int select = FindTopLevelSelect(statement);
                if (select < 0 || HasTopLevelInto(statement, select))
                {
                    continue;
                }
                return statement.GetRange(select, statement.Count - select);
            }
            return null;
        }

        private static List<string> TrimBlockKeywords(List<string> statement)
        {
            int start = 0;
            while (start < statement.Count && IsWord(statement[start], "DO", "BEGIN", "END"))
            {
                start++;
            }
            return statement.GetRange(start, statement.Count - start);
        }

        private static int FindTopLevelSelect(List<string> statement)
        {
            if (IsWord(statement[0], "SELECT"))
            {
                return 0;
            }
            if (!IsWord(statement[0], "WITH"))
            {
                return -1;
            }
            int depth = 0;
            for (int index = 0; index < statement.Count; index++)
            {
                string token = statement[index];
                if (token == "(")
                {
                    depth++;
                }
                else if (token == ")")
                {
                    depth--;
                }
                else if (depth == 0 && IsWord(token, "SELECT"))
                {
                    return index;
                }
            }
            return -1;
        }

        private static bool HasTopLevelInto(List<string> statement, int select)
        {
            int depth = 0;
            for (int index = select; index < statement.Count; index++)
            {
                string token = statement[index];
                if (token == "(")
                {
                    depth++;
                }
                else if (token == ")")
                {
                    depth--;
                }
                else if (depth == 0 && IsWord(token, "FROM"))
                {
                    return false;
                }
                else if (depth == 0 && IsWord(token, "INTO"))
                {
                    return true;
                }
            }
            return false;
        }

        private static List<List<string>> SelectItems(List<string> statement)
        {
            List<List<string>> items = new List<List<string>>();
            int index = 1;
            while (index < statement.Count && IsWord(statement[index], "DISTINCT", "ALL"))
            {
                index++;
            }
            if (index < statement.Count && IsWord(statement[index], "TOP"))
            {
                index += 2;
            }
            List<string> current = new List<string>();
            int depth = 0;
            for (; index < statement.Count; index++)
            {
                string token = statement[index];
                if (token == "(")
                {
                    depth++;
                }
                else if (token == ")")
                {
                    depth--;
                }
                if (depth == 0 && IsWord(token, "FROM"))
                {
                    break;
                }
                if (depth == 0 && token == ",")
                {
                    items.Add(current);
                    current = new List<string>();
                    continue;
                }
                current.Add(token);
            }
            items.Add(current);
            return items;
        }

        private static string ColumnName(List<string> item)
        {
            if (item.Count == 0)
            {
                return null;
            }
            string last = item[item.Count - 1];
            if (last == "*")
            {
                return null;
            }
            if (item.Count >= 2 && IsWord(item[item.Count - 2], "AS"))
            {
                return NameOf(last);
            }
            if (item.Count == 1)
            {
                return NameOf(last);
            }
            if (item.Count >= 3 && item[item.Count - 2] == ".")
            {
                // t.Column (and nothing before it except further qualifiers)
                for (int index = 0; index < item.Count - 2; index++)
                {
                    if (item[index] != "." && !IsName(item[index]))
                    {
                        return null;
                    }
                }
                return NameOf(last);
            }
            // expression followed by an implicit alias: "count(*) Total", "x.y Name"
            string previous = item[item.Count - 2];
            if (IsName(last) && !NotAnAlias.Contains(last) && (previous == ")" || IsName(previous) || previous.StartsWith("'")))
            {
                return NameOf(last);
            }
            return null;
        }

        private static string NameOf(string token)
        {
            if (token.Length >= 2 && token[0] == '"' && token[token.Length - 1] == '"')
            {
                return token.Substring(1, token.Length - 2).Replace("\"\"", "\"");
            }
            if (!IsName(token) || NotAnAlias.Contains(token))
            {
                return null;
            }
            return token;
        }

        private static bool IsName(string token)
        {
            if (token.Length == 0)
            {
                return false;
            }
            if (token[0] == '"')
            {
                return true;
            }
            if (!(char.IsLetter(token[0]) || token[0] == '_'))
            {
                return false;
            }
            foreach (char c in token)
            {
                if (!(char.IsLetterOrDigit(c) || c == '_' || c == '$' || c == '#'))
                {
                    return false;
                }
            }
            return true;
        }

        private static bool IsWord(string token, params string[] words)
        {
            foreach (string word in words)
            {
                if (string.Equals(token, word, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }
    }
}

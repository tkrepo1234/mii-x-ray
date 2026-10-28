using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace MiiXRay.SimConvert;

/// <summary>A declaration comment of the X-Ray: "Transaction.X (type), default: v", "Local.X (type)", "action X".</summary>
public sealed class Declaration
{
    public string Scope { get; set; }

    public string MiiName { get; set; }

    public string MiiType { get; set; }

    /// <summary>The MII default as the comment shows it; null when the comment shows none.</summary>
    public string DefaultText { get; set; }

    public string Key => Scope == "action" ? "action " + MiiName : Scope + "." + MiiName;
}

/// <summary>The settings of an action ("MII settings (Type):" and the lines below it).</summary>
public sealed class ActionContext
{
    public string Name { get; set; } = "";

    public string Type { get; set; }

    public bool Xacute { get; set; }

    public bool Async { get; set; }

    public List<(string Name, string Value, bool Linked)> Settings { get; } = [];

    public string Setting(string name) => Settings.Where((setting) => setting.Name == name).Select((setting) => setting.Value).FirstOrDefault();

    public bool IsTrue(string name) => Regex.IsMatch(Setting(name) ?? "", @"^\s*(true|1)\s*$", RegexOptions.IgnoreCase);
}

/// <summary>Reads the comments the X-Ray writes.</summary>
public static class Comments
{
    private static readonly Regex PropertyComment = new Regex(@"^// (Transaction|Local)\.(\S+?) \(([^)]*)\)(, default:(?: (.*))?)?$");
    private static readonly Regex ActionComment = new Regex(@"^// action (\S+)$");
    private static readonly Regex ActionName = new Regex(@"^// ([^\s:]+)(: .*)?$");
    private static readonly Regex Setting = new Regex(@"^//   (\S+?)( \(linked\))? =(?: (.*))?$");
    private static readonly Regex FileContent = new Regex(@" \(content: MiiFiles\.\w+\)$");

    public static List<string> Lines(SyntaxTriviaList trivia) =>
        trivia.Where((item) => item.IsKind(SyntaxKind.SingleLineCommentTrivia)).Select((item) => item.ToString().TrimEnd()).ToList();

    /// <summary>The last declaration comment of the lines with the default value lines below it.</summary>
    public static Declaration ParseDeclaration(List<string> lines)
    {
        for (int index = lines.Count - 1; index >= 0; index--)
        {
            Match action = ActionComment.Match(lines[index]);

            if (action.Success)
            {
                return new Declaration { Scope = "action", MiiName = action.Groups[1].Value, MiiType = "" };
            }

            Match property = PropertyComment.Match(lines[index]);

            if (!property.Success)
            {
                continue;
            }

            Declaration declaration = new Declaration { Scope = property.Groups[1].Value, MiiName = property.Groups[2].Value, MiiType = property.Groups[3].Value };

            if (property.Groups[4].Success)
            {
                if (property.Groups[5].Success && property.Groups[5].Value.Length > 0)
                {
                    declaration.DefaultText = property.Groups[5].Value;
                }
                else
                {
                    // a multi-line default: one comment line per line, two blanks in front
                    declaration.DefaultText = string.Join("\n", lines.Skip(index + 1).Select((line) => line.Length > 5 ? line.Substring(5) : ""));
                }
            }

            return declaration;
        }

        return null;
    }

    /// <summary>The comments behind a node on its line: after the next token (a comma or a closing parenthesis) and
    /// after the semicolon that may follow the parenthesis.</summary>
    public static List<string> TrailingLines(SyntaxNode node)
    {
        List<string> lines = [];
        SyntaxToken token = node.GetLastToken();

        for (int step = 0; step < 3; step++)
        {
            List<string> found = Lines(token.TrailingTrivia);
            lines.AddRange(found);

            if (found.Count > 0 || token.TrailingTrivia.Any((item) => item.IsKind(SyntaxKind.EndOfLineTrivia)))
            {
                break;
            }

            token = token.GetNextToken();

            if (!token.IsKind(SyntaxKind.CommaToken) && !token.IsKind(SyntaxKind.CloseParenToken) && !token.IsKind(SyntaxKind.SemicolonToken))
            {
                break;
            }
        }

        return lines;
    }

    /// <summary>Updates the action context with the comments in front of a statement.</summary>
    public static ActionContext Update(ActionContext context, List<string> lines)
    {
        bool settings = false;

        foreach (string line in lines)
        {
            Match name = ActionName.Match(line);

            if (name.Success && !line.StartsWith("// X-Ray"))
            {
                context = new ActionContext { Name = name.Groups[1].Value };
                settings = false;
                continue;
            }

            if (line.StartsWith("// MII settings (") && line.EndsWith("):"))
            {
                context.Type = line.Substring("// MII settings (".Length, line.Length - "// MII settings (".Length - 2);
                settings = true;
                continue;
            }

            if (line.StartsWith("// Xacute query "))
            {
                context.Xacute = true;
                continue;
            }

            if (line.Contains("MII runs this call asynchronously"))
            {
                Match when = Regex.Match(line, "asynchronously when (.*) is true:");
                context.Async = !when.Success || when.Groups[1].Value.Trim() == "true";
                continue;
            }

            if (!settings)
            {
                continue;
            }

            if (line.StartsWith("//   empty: "))
            {
                foreach (string item in line.Substring("//   empty: ".Length).Split(", "))
                {
                    bool linked = item.EndsWith(" (linked)");
                    context.Settings.Add((linked ? item.Substring(0, item.Length - " (linked)".Length) : item, "", linked));
                }

                continue;
            }

            if (line.StartsWith("//     ") && context.Settings.Count > 0)
            {
                (string Name, string Value, bool Linked) last = context.Settings[^1];
                context.Settings[^1] = (last.Name, last.Value.Length == 0 ? line.Substring(7) : last.Value + "\n" + line.Substring(7), last.Linked);
                continue;
            }

            Match setting = Setting.Match(line);

            if (setting.Success)
            {
                context.Settings.Add((setting.Groups[1].Value, FileContent.Replace(setting.Groups[3].Value, ""), setting.Groups[2].Success));
                continue;
            }

            settings = false;
        }

        return context;
    }

    /// <summary>A C# string literal.</summary>
    public static string Literal(string text)
    {
        System.Text.StringBuilder result = new System.Text.StringBuilder("\"");

        foreach (char c in text ?? "")
        {
            switch (c)
            {
                case '\\': result.Append("\\\\"); break;
                case '"': result.Append("\\\""); break;
                case '\r': result.Append("\\r"); break;
                case '\n': result.Append("\\n"); break;
                case '\t': result.Append("\\t"); break;
                default:
                    if (c < ' ')
                    {
                        result.Append("\\u").Append(((int)c).ToString("x4"));
                    }
                    else
                    {
                        result.Append(c);
                    }

                    break;
            }
        }

        return result.Append('"').ToString();
    }
}

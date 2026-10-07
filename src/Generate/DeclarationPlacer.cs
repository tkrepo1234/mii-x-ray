using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace MiiXRay.Generate
{
    /// <summary>A variable the emitter would declare at the top of Execute (MII keeps action results for the whole run).</summary>
    public sealed class HoistedVariable
    {
        public string Type;
        public string Name;
        public string Initializer;
        /// <summary>A Catch result: assigned from the exception of a catch clause.</summary>
        public bool IsCatch;
    }

    /// <summary>Moves declarations to where the value comes into being, as one would write it in C#: a variable assigned
    /// exactly once and read only afterwards in the same block (or below) is declared at its assignment; a Catch result
    /// becomes the catch clause's variable. Everything else stays at the top. Works on the finished lines of the
    /// method body, whose braces always stand on lines of their own.</summary>
    public static class DeclarationPlacer
    {
        private static readonly Regex CatchClause = new Regex(@"^catch \(Exception (\w+)\)$", RegexOptions.Compiled);

        /// <summary>Changes the flow in place and returns the variables that must stay at the top.</summary>
        public static List<HoistedVariable> Place(List<string> flow, List<HoistedVariable> variables)
        {
            List<HoistedVariable> remaining = new List<HoistedVariable>();

            foreach (HoistedVariable variable in variables)
            {
                if (!TryPlace(flow, variable))
                {
                    remaining.Add(variable);
                }
            }

            return remaining;
        }

        private static bool TryPlace(List<string> flow, HoistedVariable variable)
        {
            Regex word = new Regex(@"(?<![\w.@])" + Regex.Escape(variable.Name) + @"\b");
            Regex assignment = new Regex(@"^\s*" + Regex.Escape(variable.Name) + @" = ");
            int assigned = -1;
            List<int> uses = new List<int>();

            for (int index = 0; index < flow.Count; index++)
            {
                if (assignment.IsMatch(flow[index]))
                {
                    if (assigned >= 0)
                    {
                        return false;
                    }

                    assigned = index;

                    if (word.Matches(flow[index]).Count > 1)
                    {
                        // the new value is built from the old one
                        return false;
                    }
                }
                else if (word.IsMatch(flow[index]))
                {
                    uses.Add(index);
                }
            }

            if (assigned < 0)
            {
                return false;
            }

            int[] parents;
            int[] blocks = Blocks(flow, out parents);

            foreach (int use in uses)
            {
                if (use < assigned || !IsInside(blocks[use], blocks[assigned], parents))
                {
                    return false;
                }
            }

            if (variable.IsCatch)
            {
                return RenameCatchVariable(flow, variable, assigned);
            }

            string line = flow[assigned];
            int indent = line.Length - line.TrimStart().Length;
            flow[assigned] = line.Substring(0, indent) + "var " + line.Substring(indent);
            return true;
        }

        /// <summary>"catch (Exception xError) ... x = xError;" becomes "catch (Exception x)".</summary>
        private static bool RenameCatchVariable(List<string> flow, HoistedVariable variable, int assigned)
        {
            string error = flow[assigned].Trim();
            error = error.Substring(variable.Name.Length + 3).TrimEnd(';');

            for (int index = assigned - 1; index >= 0; index--)
            {
                Match clause = CatchClause.Match(flow[index].Trim());

                if (clause.Success && clause.Groups[1].Value == error)
                {
                    flow.RemoveAt(assigned);
                    Regex errorWord = new Regex(@"(?<![\w.@])" + Regex.Escape(error) + @"\b");

                    for (int line = index; line < flow.Count; line++)
                    {
                        flow[line] = errorWord.Replace(flow[line], variable.Name);
                    }

                    return true;
                }
            }

            return false;
        }

        /// <summary>The block of every line (0 = the method body) and the parent of every block.</summary>
        private static int[] Blocks(List<string> flow, out int[] parents)
        {
            int[] blocks = new int[flow.Count];
            List<int> parentList = new List<int>();
            parentList.Add(-1);
            Stack<int> open = new Stack<int>();
            open.Push(0);

            for (int index = 0; index < flow.Count; index++)
            {
                string text = flow[index].Trim();

                if (text == "{")
                {
                    blocks[index] = open.Peek();
                    parentList.Add(open.Peek());
                    open.Push(parentList.Count - 1);
                }
                else if (text == "}" && open.Count > 1)
                {
                    blocks[index] = open.Pop();
                }
                else
                {
                    blocks[index] = open.Peek();
                }
            }

            parents = parentList.ToArray();
            return blocks;
        }

        private static bool IsInside(int block, int ancestor, int[] parents)
        {
            while (block >= 0)
            {
                if (block == ancestor)
                {
                    return true;
                }

                block = parents[block];
            }

            return false;
        }
    }
}

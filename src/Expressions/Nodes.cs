using System.Collections.Generic;

namespace MiiXRay.Expressions
{
    /// <summary>A node of a parsed MII expression.</summary>
    public abstract class Node
    {
    }

    public sealed class EmptyNode : Node
    {
    }

    public sealed class StringNode : Node
    {
        public string Value;
    }

    public sealed class NumberNode : Node
    {
        public string Text;
    }

    public sealed class BooleanNode : Node
    {
        public bool Value;
    }

    /// <summary>A keyword without arguments: cr, lf, datenow, transactionpath, ...</summary>
    public sealed class KeywordNode : Node
    {
        public string Name;
    }

    /// <summary>A property reference: Transaction.X, Local.X or Action.Property, optionally with a selector ({xpath}, {key}, {index}).</summary>
    public sealed class ReferenceNode : Node
    {
        public string Path;
        /// <summary>The raw text inside the braces, or null.</summary>
        public string Selector;

        public string Scope
        {
            get
            {
                int dot = Path.IndexOf('.');
                return dot >= 0 ? Path.Substring(0, dot) : Path;
            }
        }

        public string Member
        {
            get
            {
                int dot = Path.IndexOf('.');
                return dot >= 0 ? Path.Substring(dot + 1) : string.Empty;
            }
        }
    }

    public sealed class FunctionNode : Node
    {
        public string Name;
        public List<Node> Arguments = new List<Node>();
    }

    public sealed class UnaryNode : Node
    {
        public string Operator;
        public Node Operand;
    }

    public sealed class BinaryNode : Node
    {
        public string Operator;
        public Node Left;
        public Node Right;
    }

    /// <summary>#expr#: the inner expression is evaluated and its result is evaluated again as an expression.</summary>
    public sealed class DynamicNode : Node
    {
        public string Text;
    }

    /// <summary>A list literal like [[string:a], [string:b]].</summary>
    public sealed class ListLiteralNode : Node
    {
        public string Text;
    }
}

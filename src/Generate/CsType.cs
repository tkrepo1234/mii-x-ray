namespace MiiXRay.Generate
{
    public enum TypeKind
    {
        String,
        Bool,
        Int,
        Long,
        Double,
        Decimal,
        DateTime,
        List,
        Map,
        Xml,
        Rowset,
        Row,
        /// <summary>A named class without MII meaning (a transaction response, a plugin result, an exception).</summary>
        Class,
        Object
    }

    /// <summary>The C# type of a generated value.</summary>
    public sealed class CsType
    {
        public static readonly CsType String = new CsType(TypeKind.String, "string", null);
        public static readonly CsType Bool = new CsType(TypeKind.Bool, "bool", null);
        public static readonly CsType Int = new CsType(TypeKind.Int, "int", null);
        public static readonly CsType Long = new CsType(TypeKind.Long, "long", null);
        public static readonly CsType Double = new CsType(TypeKind.Double, "double", null);
        public static readonly CsType Decimal = new CsType(TypeKind.Decimal, "decimal", null);
        public static readonly CsType DateTime = new CsType(TypeKind.DateTime, "DateTime", null);
        public static readonly CsType List = new CsType(TypeKind.List, "List<string>", null);
        public static readonly CsType Map = new CsType(TypeKind.Map, "Dictionary<string, string>", null);
        public static readonly CsType Xml = new CsType(TypeKind.Xml, "XmlDocument", null);
        public static readonly CsType Object = new CsType(TypeKind.Object, "object", null);

        private readonly TypeKind _kind;
        private readonly string _name;
        private readonly RowsetContract _contract;

        private CsType(TypeKind kind, string name, RowsetContract contract)
        {
            _kind = kind;
            _name = name;
            _contract = contract;
        }

        public static CsType RowsetOf(RowsetContract contract)
        {
            return new CsType(TypeKind.Rowset, contract.RowsetTypeName, contract);
        }

        public static CsType RowOf(RowsetContract contract)
        {
            return new CsType(TypeKind.Row, contract.RowTypeName, contract);
        }

        public static CsType Class(string name)
        {
            return new CsType(TypeKind.Class, name, null);
        }

        public TypeKind Kind
        {
            get { return _kind; }
        }

        /// <summary>The C# type name.</summary>
        public string Name
        {
            get { return _contract != null ? (_kind == TypeKind.Row ? _contract.RowTypeName : _contract.RowsetTypeName) : _name; }
        }

        public RowsetContract Contract
        {
            get { return _contract; }
        }

        public bool IsNumeric
        {
            get { return _kind == TypeKind.Int || _kind == TypeKind.Long || _kind == TypeKind.Double || _kind == TypeKind.Decimal; }
        }

        public bool IsSameAs(CsType other)
        {
            if (other == null || other._kind != _kind)
            {
                return false;
            }
            if (_contract != null || other._contract != null)
            {
                return _contract == other._contract;
            }
            return _name == other._name;
        }

        public override string ToString()
        {
            return Name;
        }
    }

    /// <summary>C# operator precedence levels used to decide on parentheses (higher binds tighter).</summary>
    public static class Precedence
    {
        public const int Conditional = 3;
        public const int LogicalOr = 5;
        public const int LogicalAnd = 6;
        public const int Equality = 10;
        public const int Relational = 11;
        public const int Additive = 13;
        public const int Multiplicative = 14;
        public const int Unary = 15;
        public const int Primary = 16;
    }

    /// <summary>A translated C# expression with its type.</summary>
    public sealed class TypedCode
    {
        public string Code;
        public CsType Type;
        public int Precedence;
        /// <summary>An alternative form that yields an XmlDocument (for XPath selections used as XML).</summary>
        public string XmlCode;
        /// <summary>True for literals; the value is in LiteralText.</summary>
        public bool IsLiteral;
        public string LiteralText;

        public TypedCode(string code, CsType type, int precedence)
        {
            Code = code;
            Type = type;
            Precedence = precedence;
        }

        public static TypedCode Primary(string code, CsType type)
        {
            return new TypedCode(code, type, MiiXRay.Generate.Precedence.Primary);
        }

        /// <summary>The code, in parentheses when it binds weaker than the given precedence.</summary>
        public string At(int precedence)
        {
            return Precedence < precedence ? "(" + Code + ")" : Code;
        }
    }
}

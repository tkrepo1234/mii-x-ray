using MiiXRay.Expressions;
using MiiXRay.Generate;

namespace MiiXRay.Tests
{
    public static class ExpressionTests
    {
        /// <summary>Resolves Transaction.Site/Count/Flag and Local.Map/Doc for the translator tests.</summary>
        private sealed class Symbols : ISymbolResolver
        {
            private readonly UniqueNames _names = new UniqueNames();

            public TypedCode Resolve(ReferenceNode reference)
            {
                switch (reference.Path)
                {
                    case "Transaction.Site": return TypedCode.Primary("site", CsType.String);
                    case "Transaction.Count": return TypedCode.Primary("count", CsType.Int);
                    case "Transaction.Flag": return TypedCode.Primary("flag", CsType.Bool);
                    case "Local.Map": return TypedCode.Primary("map", CsType.Map);
                    case "Local.Doc": return TypedCode.Primary("doc", CsType.Xml);
                    default: return null;
                }
            }

            public void Note(string message)
            {
            }

            public string TransactionPath
            {
                get { return "P/trxTest"; }
            }

            public string NewName(string wanted)
            {
                return _names.Claim(wanted);
            }
        }

        private static string Translate(string expression)
        {
            return new ExpressionTranslator(new Symbols()).Translate(expression).Code;
        }

        public static void ConcatenationBindsTighterThanComparison()
        {
            BinaryNode node = (BinaryNode)Parser.Parse("\"a\" & \"b\" == \"ab\"");
            Assert.Equal("==", node.Operator);
            Assert.Equal("&", ((BinaryNode)node.Left).Operator);
        }

        public static void EqualityBindsWeakerThanAnd()
        {
            BinaryNode node = (BinaryNode)Parser.Parse("a.b == c.d && e.f");
            Assert.Equal("==", node.Operator);
            Assert.Equal("&&", ((BinaryNode)node.Right).Operator);
        }

        public static void WordOperatorsAndFunctions()
        {
            Assert.Equal("&&", ((BinaryNode)Parser.Parse("x.a and x.b")).Operator);
            Assert.True(Parser.Parse("and(x.a, x.b)") is FunctionNode, "and(...) is the function");
            Assert.Equal("&&", ((BinaryNode)Parser.Parse("(x.a != \"\") and (x.b != \"\")")).Operator);
            Assert.Equal("||", ((BinaryNode)Parser.Parse("x.a or (x.b)")).Operator);
        }

        public static void SelectorKeepsQuotesAndBrackets()
        {
            ReferenceNode node = (ReferenceNode)Parser.Parse("Q.Results{/Rowsets/Rowset/Row[Name = '}']/Value}");
            Assert.Equal("/Rowsets/Rowset/Row[Name = '}']/Value", node.Selector);
        }

        public static void CommentOnlyIsEmpty()
        {
            Assert.True(Parser.Parse("/* nothing */") is EmptyNode, "a comment alone is an empty expression");
        }

        public static void ConcatenationBecomesInterpolation()
        {
            Assert.Equal("$\"Site {site} has {count} {{rows}}\"", Translate("\"Site \" & Transaction.Site & \" has \" & Transaction.Count & \" {rows}\""));
            Assert.Equal("site + Mii.ToStr(flag)", Translate("Transaction.Site & Transaction.Flag"));
        }

        public static void EmptyStringIsDroppedFromConcatenation()
        {
            Assert.Equal("Mii.ToStr(count)", Translate("Transaction.Count & \"\""));
        }

        public static void MatchIsCaseSensitiveRegex()
        {
            Assert.Equal("Regex.IsMatch(site, \"^M$\")", Translate("match(Transaction.Site, \"^M$\")"));
        }

        public static void MiiIdiomsHaveNames()
        {
            Assert.Equal("Mii.IsEmpty(site)", Translate("match(Transaction.Site, \"(?i)^\\s*(null|\\-{3})?\\s*$\")"));
            Assert.Equal("Mii.IsTrue(site)", Translate("match(Transaction.Site, \"(?i)^\\s*(true|1)\\s*$\")"));
            Assert.Equal("count > 5", Translate("number(\"0\" & Transaction.Count) > 5"));
        }

        public static void StringIfBecomesConditional()
        {
            Assert.Equal("flag ? \"yes\" : \"no\"", Translate("stringif(Transaction.Flag, \"yes\", \"no\")"));
        }

        public static void MixedEqualityUsesHelper()
        {
            Assert.Equal("Mii.AreEqual(site, 1)", Translate("Transaction.Site == 1"));
            Assert.Equal("site == \"M\"", Translate("Transaction.Site == \"M\""));
        }

        public static void DivisionIsNotInteger()
        {
            Assert.Equal("(double)count / 2", Translate("Transaction.Count / 2"));
        }

        public static void MapAndXmlSelectors()
        {
            Assert.Equal("Mii.MapGet(map, \"Key\")", Translate("Local.Map{Key}"));
            Assert.Equal("Mii.XPath(doc, \"/a/b\")", Translate("Local.Doc{/a/b}"));
        }

        public static void KeywordsAndUnknownFunctions()
        {
            Assert.Equal("\"P/trxTest\"", Translate("transactionpath"));
            Assert.Contains("Mii.Function(\"nosuchfunction\"", Translate("nosuchfunction(1)"));
        }

        public static void UnknownReferenceStillCompiles()
        {
            Assert.Equal("Mii.Unresolved(\"Transaction.Missing\")", Translate("Transaction.Missing"));
        }

        public static void InterpolationAndLiteralForms()
        {
            Assert.Equal("$\"Site: {site}\"", Translate("\"Site: #Transaction.Site#\""));
            Assert.Equal("@\"[\\*#]$\"", Translate("\"[\\\\*#]$\""));
            Assert.Equal("\"\"\"<a x=\"1\"/>\"\"\"", Translate("\"<a x=\\\"1\\\"/>\""));
        }
    }
}
